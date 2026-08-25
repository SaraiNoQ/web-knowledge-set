fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "take_external_intents",
            "read_external_text",
            "read_external_binary",
            "discard_external_tokens",
            "llm_keychain_status",
            "set_llm_api_key",
            "delete_llm_api_key",
            "choose_data_directory",
            "change_data_directory",
            "cancel_staged_data_directory_change",
            "updater_configured",
            "restart_after_update",
        ]),
    ))
    .expect("failed to build Tauri application manifest")
}
