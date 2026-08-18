use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

use nostr_vpn_app_core::{FfiApp, NativeAppAction};

fn main() -> ExitCode {
    let mut args = env::args_os().skip(1);
    let Some(config_path) = args.next().map(PathBuf::from) else {
        eprintln!("config path is required");
        return ExitCode::FAILURE;
    };
    let Some(join_request) = args.next().and_then(|value| value.into_string().ok()) else {
        eprintln!("join request is required");
        return ExitCode::FAILURE;
    };
    let nvpn_binary = args.next().map(PathBuf::from);
    if args.next().is_some() {
        eprintln!("unexpected argument");
        return ExitCode::FAILURE;
    }

    let app = FfiApp::new_with_config_path(config_path, "webvm-e2e".to_string(), nvpn_binary);
    let state = app.dispatch(NativeAppAction::ImportJoinRequest {
        request: join_request,
    });
    if !state.error.is_empty() {
        eprintln!("{}", state.error);
        return ExitCode::FAILURE;
    }
    println!("{}", state.vpn_status);
    ExitCode::SUCCESS
}
