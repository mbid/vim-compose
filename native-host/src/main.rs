use byteorder::{NativeEndian, ReadBytesExt, WriteBytesExt};
use log::info;
use simplelog::{LevelFilter, WriteLogger};
use std::fs::File;
use std::io::{stdin, stdout, Read, Write};

fn read_message(pipe: &mut impl Read) -> bool {
    let msg_len = pipe.read_u32::<NativeEndian>().unwrap();
    info!("Got message of length {msg_len}");
    if msg_len == 0 {
        return false;
    }

    let mut msg: Vec<u8> = vec![0; msg_len as usize];
    pipe.read_exact(&mut msg).unwrap();
    true
}

fn write_message(message: &[u8], pipe: &mut impl Write) {
    let msg_len = u32::try_from(message.len()).unwrap();
    info!("Writing message with length {msg_len}");
    pipe.write_u32::<NativeEndian>(msg_len).unwrap();
    pipe.write_all(message).unwrap();
    pipe.flush().unwrap();
}

fn main() {
    WriteLogger::init(
        LevelFilter::Trace,
        simplelog::Config::default(),
        File::create("/tmp/native-host-log").unwrap(),
    )
    .unwrap();

    let mut i = 0;
    while read_message(&mut stdin().lock()) {
        i += 1;
        let message = format!("{{ \"date\": {i} }}");
        write_message(message.as_bytes(), &mut stdout().lock());
    }
    info!("Exiting");
}
