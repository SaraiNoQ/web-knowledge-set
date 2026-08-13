use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
const SERVICE: &str = "io.github.sarainoq.zhiye.llm";
#[cfg(target_os = "macos")]
const LEGACY_SERVICE: &str = "dev.local.zhiye.llm";
#[cfg(target_os = "macos")]
const LEGACY_ACCOUNT: &str = "openai-compatible";
#[cfg(target_os = "macos")]
const BOUND_ACCOUNT: &str = "openai-compatible-bound-v1";
#[cfg(any(target_os = "macos", test))]
const MAX_API_KEY_BYTES: usize = 16 * 1024;
#[cfg(any(target_os = "macos", test))]
const MAX_ENDPOINT_BYTES: usize = 2_000;
#[cfg(target_os = "macos")]
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeychainStatus {
    configured: bool,
    endpoint_url: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LlmCredentials {
    pub(crate) api_key: String,
    pub(crate) endpoint_url: String,
}

#[cfg(any(target_os = "macos", test))]
fn keychain_status(credentials: Option<LlmCredentials>) -> KeychainStatus {
    let endpoint_url = credentials.map(|value| value.endpoint_url);
    KeychainStatus {
        configured: endpoint_url.is_some(),
        endpoint_url,
    }
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

#[cfg(any(target_os = "macos", test))]
fn normalized_https_endpoint(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_ENDPOINT_BYTES || value.chars().any(char::is_control) {
        return Err("远程端点必须为不超过 2000 字节的 HTTPS 地址".to_owned());
    }
    let url = tauri::Url::parse(value).map_err(|_| "远程端点格式无效".to_owned())?;
    let authority = value
        .split_once("://")
        .map(|(_, rest)| rest.split(&['/', '?', '#'][..]).next().unwrap_or(""))
        .unwrap_or("");
    if url.scheme() != "https"
        || url.host_str().is_none()
        || authority.contains('@')
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err("远程端点必须使用 HTTPS，且不能包含凭据、查询参数或片段".to_owned());
    }
    Ok(url.to_string())
}

#[cfg(any(target_os = "macos", test))]
fn encode_credentials(api_key: &str, endpoint_url: &str) -> Result<(String, String), String> {
    let api_key = api_key.trim();
    validate_api_key(api_key)?;
    let endpoint_url = normalized_https_endpoint(endpoint_url)?;
    let value = serde_json::to_string(&LlmCredentials {
        api_key: api_key.to_owned(),
        endpoint_url: endpoint_url.clone(),
    })
    .map_err(|_| "无法编码钥匙串密钥".to_owned())?;
    Ok((value, endpoint_url))
}

#[cfg(any(target_os = "macos", test))]
fn decode_credentials(value: &str) -> Result<LlmCredentials, String> {
    let credentials: LlmCredentials =
        serde_json::from_str(value).map_err(|_| "钥匙串中的密钥绑定格式无效".to_owned())?;
    validate_api_key(&credentials.api_key).map_err(|_| "钥匙串中的密钥绑定格式无效".to_owned())?;
    let endpoint = normalized_https_endpoint(&credentials.endpoint_url)
        .map_err(|_| "钥匙串中的密钥绑定格式无效".to_owned())?;
    if endpoint != credentials.endpoint_url {
        return Err("钥匙串中的密钥绑定格式无效".to_owned());
    }
    Ok(credentials)
}

#[cfg(target_os = "macos")]
fn bound_account() -> &'static str {
    if cfg!(debug_assertions) && std::env::var("ZHIYE_KEYCHAIN_SMOKE").as_deref() == Ok("1") {
        "openai-compatible-bound-v1-smoke"
    } else {
        BOUND_ACCOUNT
    }
}

#[cfg(target_os = "macos")]
fn legacy_account() -> &'static str {
    if cfg!(debug_assertions) && std::env::var("ZHIYE_KEYCHAIN_SMOKE").as_deref() == Ok("1") {
        "openai-compatible-smoke"
    } else {
        LEGACY_ACCOUNT
    }
}

#[cfg(target_os = "macos")]
fn read_for_account(service: &str, account: &str) -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(service, account) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "钥匙串条目格式无效".to_owned()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(_) => Err("无法访问 macOS 钥匙串".to_owned()),
    }
}

#[cfg(target_os = "macos")]
fn write_for_account(service: &str, account: &str, value: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(service, account, value.as_bytes())
        .map_err(|_| "无法写入 macOS 钥匙串".to_owned())
}

#[cfg(target_os = "macos")]
fn delete_for_account(service: &str, account: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(service, account) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(_) => Err("无法从 macOS 钥匙串删除密钥".to_owned()),
    }
}

#[cfg(target_os = "macos")]
fn read_bound(account: &str) -> Result<Option<LlmCredentials>, String> {
    read_for_account(SERVICE, account)?
        .map(|value| decode_credentials(&value))
        .transpose()
}

#[cfg(target_os = "macos")]
fn replace_bound(
    bound_account: &str,
    legacy_account: &str,
    api_key: &str,
    endpoint_url: &str,
) -> Result<String, String> {
    let (value, endpoint_url) = encode_credentials(api_key, endpoint_url)?;
    write_for_account(SERVICE, bound_account, &value)?;
    let _ = delete_legacy_entries(bound_account, legacy_account);
    Ok(endpoint_url)
}

#[cfg(target_os = "macos")]
fn delete_legacy_entries(bound_account: &str, legacy_account: &str) -> Result<(), String> {
    let legacy_bound = delete_for_account(LEGACY_SERVICE, bound_account);
    let current_key = delete_for_account(SERVICE, legacy_account);
    let legacy_key = delete_for_account(LEGACY_SERVICE, legacy_account);
    legacy_bound.and(current_key).and(legacy_key)
}

#[cfg(target_os = "macos")]
fn delete_all(bound_account: &str, legacy_account: &str) -> Result<(), String> {
    let current_bound = delete_for_account(SERVICE, bound_account);
    let legacy = delete_legacy_entries(bound_account, legacy_account);
    current_bound.and(legacy)
}

#[cfg(target_os = "macos")]
pub(crate) fn load_credentials() -> Result<Option<LlmCredentials>, String> {
    read_bound(bound_account())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn load_credentials() -> Result<Option<LlmCredentials>, String> {
    Ok(None)
}

#[cfg(debug_assertions)]
pub(crate) fn seed_smoke_api_key() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if std::env::var("ZHIYE_KEYCHAIN_SMOKE").as_deref() == Ok("1") {
        replace_bound(
            bound_account(),
            legacy_account(),
            "zhiye-isolated-smoke-key",
            "https://api.openai.com/v1/chat/completions",
        )?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn llm_keychain_status() -> Result<KeychainStatus, String> {
    #[cfg(target_os = "macos")]
    {
        return read_bound(bound_account()).map(keychain_status);
    }
    #[cfg(not(target_os = "macos"))]
    Err("密钥存储仅支持 macOS 桌面应用".to_owned())
}

#[tauri::command]
pub(crate) fn set_llm_api_key(
    api_key: String,
    endpoint_url: String,
) -> Result<KeychainStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let endpoint_url =
            replace_bound(bound_account(), legacy_account(), &api_key, &endpoint_url)?;
        return Ok(KeychainStatus {
            configured: true,
            endpoint_url: Some(endpoint_url),
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (api_key, endpoint_url);
        Err("密钥存储仅支持 macOS 桌面应用".to_owned())
    }
}

#[tauri::command]
pub(crate) fn delete_llm_api_key() -> Result<KeychainStatus, String> {
    #[cfg(target_os = "macos")]
    {
        delete_all(bound_account(), legacy_account())?;
        return Ok(KeychainStatus {
            configured: false,
            endpoint_url: None,
        });
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

    #[test]
    fn credentials_bind_the_key_to_one_normalized_https_endpoint() {
        let (encoded, endpoint_url) =
            encode_credentials("  sk-test  ", " https://EXAMPLE.com/v1/chat/completions ")
                .expect("encode credentials");
        assert_eq!(endpoint_url, "https://example.com/v1/chat/completions");
        let credentials = decode_credentials(&encoded).expect("decode credentials");
        assert_eq!(
            credentials,
            LlmCredentials {
                api_key: "sk-test".to_owned(),
                endpoint_url: "https://example.com/v1/chat/completions".to_owned(),
            }
        );
        let status = keychain_status(Some(credentials));
        assert!(status.configured);
        assert_eq!(status.endpoint_url.as_deref(), Some(endpoint_url.as_str()));
        assert!(decode_credentials("sk-legacy-only-key").is_err());
    }

    #[test]
    fn endpoint_validation_rejects_unbound_or_ambiguous_targets() {
        for endpoint in [
            "http://example.com/v1/chat/completions",
            "https://@example.com/v1/chat/completions",
            "https://user:secret@example.com/v1/chat/completions",
            "https://example.com/v1/chat/completions?model=a",
            "https://example.com/v1/chat/completions#fragment",
            "https://",
            "https://example.com:0/v1/chat/completions",
        ] {
            assert!(normalized_https_endpoint(endpoint).is_err(), "{endpoint}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn isolated_macos_keychain_round_trip_does_not_load_legacy_key() {
        let suffix = format!(
            "test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock before epoch")
                .as_nanos()
        );
        let bound_account = format!("bound-{suffix}");
        let legacy_account = format!("legacy-{suffix}");
        struct Cleanup(String, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete_all(&self.0, &self.1);
            }
        }
        let _cleanup = Cleanup(bound_account.clone(), legacy_account.clone());

        let (legacy_bound, _) = encode_credentials(
            "sk-legacy-bound-test",
            "https://legacy.example.com/v1/chat/completions",
        )
        .expect("encode legacy binding");
        write_for_account(LEGACY_SERVICE, &bound_account, &legacy_bound)
            .expect("write legacy binding");
        write_for_account(SERVICE, &legacy_account, "sk-current-unbound-test")
            .expect("write current unbound key");
        write_for_account(LEGACY_SERVICE, &legacy_account, "sk-legacy-unbound-test")
            .expect("write legacy unbound key");
        assert_eq!(
            read_bound(&bound_account).expect("read missing binding"),
            None
        );

        let endpoint_url = replace_bound(
            &bound_account,
            &legacy_account,
            "sk-isolated-test",
            "https://example.com/v1/chat/completions",
        )
        .expect("write bound credentials");
        assert_eq!(endpoint_url, "https://example.com/v1/chat/completions");
        assert_eq!(
            read_bound(&bound_account).expect("read binding"),
            Some(LlmCredentials {
                api_key: "sk-isolated-test".to_owned(),
                endpoint_url: "https://example.com/v1/chat/completions".to_owned(),
            })
        );
        let status = keychain_status(read_bound(&bound_account).expect("read binding status"));
        assert!(status.configured);
        assert_eq!(status.endpoint_url.as_deref(), Some(endpoint_url.as_str()));
        assert_eq!(
            read_for_account(LEGACY_SERVICE, &bound_account).expect("read legacy binding"),
            None
        );
        assert_eq!(
            read_for_account(SERVICE, &legacy_account).expect("read current unbound key"),
            None
        );
        assert_eq!(
            read_for_account(LEGACY_SERVICE, &legacy_account).expect("read legacy unbound key"),
            None
        );

        delete_all(&bound_account, &legacy_account).expect("delete all credentials");
        assert_eq!(
            read_bound(&bound_account).expect("read deleted binding"),
            None
        );
        assert_eq!(
            read_for_account(LEGACY_SERVICE, &legacy_account).expect("read deleted legacy key"),
            None
        );
    }
}
