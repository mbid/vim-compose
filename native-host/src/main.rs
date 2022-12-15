use byteorder::{NativeEndian, ReadBytesExt, WriteBytesExt};
use indoc::formatdoc;
use inotify::{Inotify, WatchMask};
use log::{error, info, warn};
use nix::sys::signal::{kill, Signal};
use nix::unistd::Pid;
use scopeguard::defer;
use serde::{Deserialize, Serialize};
use simplelog::{LevelFilter, WriteLogger};
use std::cell::Cell;
use std::fs;
use std::fs::File;
use std::io::{self, stdin, stdout, Read, Write};
use std::marker::Send;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Sender};
use std::thread;
use tempdir::TempDir;

use std::time::Duration;

/// Spawns a thread that runs a provided function. When the thread is finished, the result of
/// running the function is sent via the provided Sender.
fn spawn_thread<T: Send + 'static>(done_sender: Sender<T>, f: impl 'static + Send + FnOnce() -> T) {
    thread::spawn(move || {
        // TODO: Handle panics as well.
        done_sender.send(f()).unwrap();
    });
}

fn spawn_editor(src_path: &Path) -> io::Result<(Child, Pid)> {
    // Killing the gnome-terminal process launched here doesn't actually close the terminal,
    // because that is hosted by some daemon process. Instead we return the PID of the process
    // running inside of gnome-terminal. To learn its PID, we perform the following dance:
    //
    // 1. Run a shell child process for gnome-terminal.
    // 2. Print its PID to some temporary file via atomic renaming.
    // 3. Replace the shell process by the editor process.
    // 4. Wait until the PID file appears, then read off the PID from that.
    let src_path_disp = src_path.display();

    let pid_dir = TempDir::new("editor-pid")?;

    let tmp_pid_path = pid_dir.path().join("pid-tmp");
    let tmp_pid_path_disp = tmp_pid_path.display();

    let pid_path = pid_dir.path().join("pid");
    let pid_path_disp = pid_path.display();

    let child = Command::new("gnome-terminal")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("--wait")
        .arg("--hide-menubar")
        .arg("--")
        .arg("sh")
        .arg("-c")
        .arg(formatdoc! {"
            echo $$ > '{tmp_pid_path_disp}'
            mv '{tmp_pid_path_disp}' '{pid_path_disp}'
            exec vim '{src_path_disp}'
        "})
        .spawn()?;
    let mut pid = String::new();
    while pid.is_empty() {
        if pid_path.exists() {
            pid = fs::read_to_string(&pid_path)?;
        } else {
            thread::sleep(Duration::from_millis(5));
        }
    }
    let pid = pid.trim().parse::<i32>().unwrap();
    Ok((child, Pid::from_raw(pid)))
}

#[derive(Serialize, Deserialize, Debug)]
enum ContentType {
    Plain,
    Html,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Begin {
        initial_content: String,
        content_type: ContentType,
    },
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
enum HostMessage {
    ReplaceAll { content: String },
}

fn read_message(pipe: &mut impl Read) -> io::Result<ClientMessage> {
    let msg_len = pipe.read_u32::<NativeEndian>()?;

    serde_json::from_reader(pipe.take(msg_len.into())).map_err(|err| err.into())
}

fn write_message(message: &HostMessage, pipe: &mut impl Write) -> io::Result<()> {
    let message: Vec<u8> = serde_json::to_string(&message)?.into_bytes();
    let msg_len = u32::try_from(message.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Tried sending message of more than 2^32 bytes",
        )
    })?;
    pipe.write_u32::<NativeEndian>(msg_len)?;
    pipe.write_all(&message)?;
    pipe.flush()?;
    Ok(())
}

fn disconnect(pipe: &mut impl Write) -> io::Result<()> {
    pipe.write_u32::<NativeEndian>(0)?;
    Ok(())
}

fn write_html_as_markdown(output: &Path, html: &str) -> io::Result<()> {
    let mut pandoc = Command::new("pandoc")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("-")
        .arg("--sandbox")
        .arg("--output")
        .arg(output)
        .arg("--from")
        .arg("html")
        .arg("--to")
        .arg("gfm")
        .spawn()?;

    let sanitized_html: ammonia::Document = ammonia::Builder::new().clean(html);
    sanitized_html.write_to(pandoc.stdin.take().unwrap())?;

    let status = pandoc.wait()?;
    if !status.success() {
        warn!("pandoc exited with status {status}");
    }
    Ok(())
}

fn read_markdown_as_html(input: &Path) -> io::Result<String> {
    let mut pandoc = Command::new("pandoc")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .arg(input)
        .arg("--sandbox")
        .arg("--output")
        .arg("-")
        .arg("--from")
        .arg("gfm")
        .arg("--to")
        .arg("html")
        .spawn()?;
    let html: ammonia::Document =
        ammonia::Builder::new().clean_from_reader(pandoc.stdout.take().unwrap())?;
    let status = pandoc.wait()?;
    if !status.success() {
        warn!("pandoc exited with status {status}");
    }
    Ok(html.to_string())
}

fn handle_messages(tmp_dir: &Path, exit: Sender<io::Result<()>>) -> io::Result<()> {
    let stdin = &mut stdin().lock();
    let mut got_begin_message = false;

    // The process id of the editor if we've started it, and a scope guard to make sure we're
    // terminating the editor if this function exists.
    let editor_pid: Cell<Option<Pid>> = Cell::new(None);
    defer! {
        if let Some(editor_pid) = editor_pid.get() {
            info!("Killing editor process {editor_pid}");
            if kill(editor_pid, Signal::SIGTERM).is_err() {
                error!("Could not kill editor");
            }
        }
    };

    loop {
        let message = match read_message(stdin) {
            Ok(message) => message,
            Err(err) => {
                if err.kind() == io::ErrorKind::UnexpectedEof {
                    info!("Stdin was closed, exiting");
                    return Ok(());
                }
                return Err(err);
            }
        };

        let ClientMessage::Begin {
            initial_content,
            content_type,
        } = message;
        info!("Received \"begin\" message");
        if got_begin_message {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Received \"begin\" message twice",
            ));
        }
        got_begin_message = true;
        let src_path = match content_type {
            ContentType::Html => {
                let src_path = tmp_dir.join("input.md");
                write_html_as_markdown(&src_path, &initial_content)?;
                src_path
            }
            ContentType::Plain => {
                let src_path = tmp_dir.join("input");
                fs::write(&src_path, &initial_content)?;
                src_path
            }
        };
        let (mut child, child_pid) = spawn_editor(&src_path)?;
        editor_pid.set(Some(child_pid));
        spawn_thread(exit.clone(), move || {
            child.wait()?;
            error!("Editor process exited");
            Ok(())
        });

        {
            let src_path = src_path.clone();
            spawn_thread(exit.clone(), move || send_updates(&src_path, content_type));
        }
    }
}

fn send_updates(src_path: &Path, content_type: ContentType) -> io::Result<()> {
    let mut last_html: Option<String> = None;
    let mut inotify = Inotify::init()?;
    let mask = WatchMask::CLOSE_WRITE
        | WatchMask::CREATE
        | WatchMask::DELETE
        | WatchMask::MODIFY
        | WatchMask::MOVE_SELF
        | WatchMask::MOVED_TO;
    inotify.add_watch(src_path, mask)?;
    let mut buffer = [0; 1024];
    loop {
        info!("Checking for updates in source");
        let html = match content_type {
            ContentType::Html => read_markdown_as_html(src_path)?,
            ContentType::Plain => fs::read_to_string(src_path)?,
        };
        if Some(&html) != last_html.as_ref() {
            info!("Generated HTML changed, sending update");
            last_html = Some(html.clone());
            let message = HostMessage::ReplaceAll { content: html };
            write_message(&message, &mut stdout().lock())?;
        }
        inotify.read_events_blocking(&mut buffer)?;
        loop {
            match inotify.read_events(&mut buffer) {
                Ok(mut events) => {
                    if events.next().is_none() {
                        break;
                    }
                }
                Err(err) => {
                    if err.kind() == io::ErrorKind::WouldBlock {
                        break;
                    } else {
                        return Err(err);
                    }
                }
            }
        }
    }
}

fn main() -> io::Result<()> {
    WriteLogger::init(
        LevelFilter::Trace,
        simplelog::Config::default(),
        File::create("/tmp/native-host-log")?,
    )
    .unwrap();

    let (sender, receiver) = channel::<io::Result<()>>();

    let tmp_dir = TempDir::new("mail")?;

    {
        let tmp_dir: PathBuf = tmp_dir.path().into();
        let sender = sender.clone();
        spawn_thread(sender.clone(), move || handle_messages(&tmp_dir, sender));
    }

    let result = receiver.recv().unwrap();
    if let Err(err) = result {
        error!("{err}");
        error!("{}", err.kind());
    }

    disconnect(&mut stdout().lock())?;
    info!("Exiting");
    Ok(())
}
