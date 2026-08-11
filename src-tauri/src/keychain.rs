use serde::Serialize;

#[cfg(target_os = "macos")]
const SERVICE: &str = "dev.local.zhiye.llm";
#[cfg(target_os = "macos")]
const ACCOUNT: &str = "openai-compatible";
#[cfg(any(target_os = "macos", test))]
const MAX_API_KEY_BYTES: usize = 16 * 1024;
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeychainStatus {
    configured: bool,
}

#[cfg(any(target_os = "macos", test))]
fn validate_api_key(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > MAX_API_KEY_BYTES
        || value.chars().any(char::is_control)
    {
        return Err("密钥必须为 1–16384 字节，且不能包含控制字符".to_owned());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn account() -> &'static str {
    if cfg!(debug_assertions) && std::env::var("ZHIYE_KEYCHAIN_SMOKE").as_deref() == Ok("1") {
        "openai-compatible-smoke"
    } else {
        ACCOUNT
    }
}

#[cfg(target_os = "macos")]
fn read_for_account(account: &str) -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(SERVICE, account) {
        Ok(bytes) => {
            let value = String::from_utf8(bytes)
                .map_err(|_| "钥匙串中的密钥格式无效".to_owned())?;
            validate_api_key(&value).map_err(|_| "钥匙串中的密钥格式无效".to_owned())?;
            Ok(Some(value))
        }
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(_) => Err("无法访问 macOS 钥匙串".to_owned()),
    }
}

#[cfg(target_os = "macos")]
fn write_for_account(account: &str, value: &str) -> Result<(), String> {
    validate_api_key(value)?;
    security_framework::passwords::set_generic_password(SERVICE, account, value.as_bytes())
        .map_err(|_| "无法写入 macOS 钥匙串".to_owned())
}

#[cfg(target_os = "macos")]
fn delete_for_account(account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, account) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(_) => Err("无法从 macOS 钥匙串删除密钥".to_owned()),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn load_api_key() -> Result<Option<String>, String> {
    read_for_account(account())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn load_api_key() -> Result<Option<String>, String> {
    Ok(None)
}

#[tauri::command]
pub(crate) fn llm_keychain_status() -> Result<KeychainStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return read_for_account(account()).map(|value| KeychainStatus {
            configured: value.is_some(),
        });
    }
    #[cfg(not(target_os = "macos"))]
    Err("密钥存储仅支持 macOS 桌面应用".to_owned())
}

#[tauri::command]
pub(crate) fn set_llm_api_key(api_key: String) -> Result<KeychainStatus, String> {
    #[cfg(target_os = "macos")]
    {
        write_for_account(account(), &api_key)?;
        return Ok(KeychainStatus { configured: true });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = api_key;
        Err("密钥存储仅支持 macOS 桌面应用".to_owned())
    }
}

#[tauri::command]
pub(crate) fn delete_llm_api_key() -> Result<KeychainStatus, String> {
    #[cfg(target_os = "macos")]
    {
        delete_for_account(account())?;
        return Ok(KeychainStatus { configured: false });
    }
    #[cfg(not(target_os = "macos"))]
    Err("密钥存储仅支持 macOS 桌面应用".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_key_validation_rejects_empty_oversized_and_control_characters() {
        assert!(validate_api_key("sk-test").is_ok());
        assert!(validate_api_key("").is_err());
        assert!(validate_api_key("   ").is_err());
        assert!(validate_api_key("line\nbreak").is_err());
        assert!(validate_api_key(&"x".repeat(MAX_API_KEY_BYTES + 1)).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn isolated_macos_keychain_round_trip() {
        let account = format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos()
        );
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete_for_account(&self.0);
            }
        }
        let _cleanup = Cleanup(account.clone());

        assert_eq!(read_for_account(&account).expect("read missing key"), None);
        write_for_account(&account, "sk-isolated-test").expect("write key");
        assert_eq!(
            read_for_account(&account).expect("read key").as_deref(),
            Some("sk-isolated-test")
        );
        delete_for_account(&account).expect("delete key");
        assert_eq!(read_for_account(&account).expect("read deleted key"), None);
    }
}
