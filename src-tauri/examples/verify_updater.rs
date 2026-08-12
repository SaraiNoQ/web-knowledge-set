use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs::File, io::Read, path::Path};

fn decode(value: &str) -> String {
    String::from_utf8(
        STANDARD
            .decode(value.trim())
            .expect("invalid base64 updater data"),
    )
    .expect("updater data is not UTF-8")
}

fn main() {
    let mut args = env::args_os().skip(1);
    let public_key = args.next().expect("public key is required");
    let archive = args.next().expect("archive path is required");
    let signature = args.next().expect("signature path is required");
    assert!(args.next().is_none(), "unexpected argument");

    let key = PublicKey::decode(&decode(&public_key.to_string_lossy()))
        .expect("invalid updater public key");
    let signature = Signature::decode(&decode(
        &std::fs::read_to_string(Path::new(&signature)).expect("cannot read updater signature"),
    ))
    .expect("invalid updater signature");
    let mut verifier = key
        .verify_stream(&signature)
        .expect("unsupported updater signature");
    let mut file = File::open(archive).expect("cannot read updater archive");
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut chunk).expect("cannot read updater archive");
        if read == 0 {
            break;
        }
        verifier.update(&chunk[..read]);
    }
    verifier
        .finalize()
        .expect("updater public and private keys do not match");
}
