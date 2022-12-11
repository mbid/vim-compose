use byteorder::{NativeEndian, ReadBytesExt, WriteBytesExt};
use log::info;
use serde::{Deserialize, Serialize};
use simplelog::{LevelFilter, WriteLogger};
use std::fs::File;
use std::io::{stdin, stdout, Read, Write};
use std::path::Path;
use std::process::{exit, Command, Stdio};
use std::thread::sleep;
use std::time::Duration;
use tempdir::TempDir;

#[derive(Serialize, Deserialize, Debug)]
enum ContentType {
    Plain,
    Html,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
enum ClientMessage {
    #[serde(rename_all = "camelCase")]
    Begin {
        initial_content: String,
        content_type: ContentType,
    },
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
enum HostMessage {
    ReplaceAll(String),
}

fn read_message(pipe: &mut impl Read) -> Option<ClientMessage> {
    let msg_len = pipe.read_u32::<NativeEndian>().unwrap();
    info!("Got message of length {msg_len}");
    if msg_len == 0 {
        return None;
    }

    Some(serde_json::from_reader(pipe.take(msg_len.into())).unwrap())
}

fn write_message(message: &HostMessage, pipe: &mut impl Write) {
    let message: Vec<u8> = serde_json::to_string(&message).unwrap().into_bytes();
    let msg_len = u32::try_from(message.len()).unwrap();
    info!("Writing message with length {msg_len}");
    pipe.write_u32::<NativeEndian>(msg_len).unwrap();
    pipe.write_all(&message).unwrap();
    pipe.flush().unwrap();
}

fn disconnect(pipe: &mut impl Write) {
    pipe.write_u32::<NativeEndian>(0).unwrap();
}

fn write_html_as_markdown(output: &Path, html: &str) {
    let mut pandoc = Command::new("pandoc")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("-")
        .arg("--output")
        .arg(output)
        .arg("--from")
        .arg("html")
        .arg("--to")
        .arg("gfm")
        .spawn()
        .unwrap();
    pandoc
        .stdin
        .take()
        .unwrap()
        .write_all(html.as_bytes())
        .unwrap();

    let status = pandoc.wait().unwrap();
    assert!(status.success());
}

fn read_markdown_as_html(input: &Path) -> String {
    let mut pandoc = Command::new("pandoc")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .arg(input)
        .arg("--output")
        .arg("-")
        .arg("--from")
        .arg("gfm")
        .arg("--to")
        .arg("html")
        .spawn()
        .unwrap();
    let mut html = String::new();
    pandoc
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut html)
        .unwrap();
    let status = pandoc.wait().unwrap();
    assert!(status.success());
    html
}

fn main() {
    WriteLogger::init(
        LevelFilter::Trace,
        simplelog::Config::default(),
        File::create("/tmp/native-host-log").unwrap(),
    )
    .unwrap();

    let (initial_content, _) = match read_message(&mut stdin().lock()) {
        Some(ClientMessage::Begin {
            initial_content,
            content_type,
        }) => (initial_content, content_type),
        None => {
            exit(1);
        }
    };

    let tmp_dir = TempDir::new("mail").unwrap();
    let src_path = tmp_dir.path().join("message.md");

    write_html_as_markdown(&src_path, &initial_content);

    let mut editor_child = Command::new("term")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .arg("--wait")
        .arg("--")
        .arg("vim")
        .arg(&src_path)
        .spawn()
        .unwrap();

    let mut last_html: Option<String> = None;
    loop {
        let html = read_markdown_as_html(&src_path);
        if Some(&html) != last_html.as_ref() {
            last_html = Some(html.clone());
            let message = HostMessage::ReplaceAll(html);
            write_message(&message, &mut stdout().lock());
        }
        if let Some(_) = editor_child.try_wait().unwrap() {
            break;
        }
        sleep(Duration::from_secs(1));
    }
    disconnect(&mut stdout().lock());
    info!("Exiting");
}
