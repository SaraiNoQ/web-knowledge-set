mod external;
mod keychain;
mod launcher;

use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{DragDropEvent, Manager, RunEvent, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const STARTING: u8 = 0;
const READY: u8 = 1;
const FAILED: u8 = 2;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const STDERR_LIMIT: usize = 8 * 1024;
const SIDECAR_ENVIRONMENT: [(&str, &str); 4] = [
    ("KB_DEV", "0"),
    ("KB_PORT", "0"),
    ("KB_BOOTSTRAP_TOKEN", ""),
    ("NODE_ENV", "production"),
];

struct LocalService {
    child: Mutex<Option<CommandChild>>,
    phase: AtomicU8,
    stderr: Mutex<String>,
    stopping: AtomicBool,
    restart_after_shutdown: AtomicBool,
    close_attempt: Mutex<Option<u64>>,
    next_close_attempt: AtomicU64,
    accepted_origin: Arc<Mutex<Option<String>>>,
}

fn parse_ready_url(value: &str) -> Result<(tauri::Url, String), String> {
    let url = tauri::Url::parse(value.trim()).map_err(|_| "READY URL 格式无效".to_owned())?;
    let port = url.port().filter(|port| *port > 0);
    let mut query = url.query_pairs();
    let token = query.next();
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || port.is_none()
        || url.path() != "/launch"
        || url.fragment().is_some()
        || !matches!(token.as_ref(), Some((key, value)) if key == "token" && !value.is_empty())
        || query.next().is_some()
    {
        return Err("READY URL 不在允许的本地启动边界内".to_owned());
    }
    drop(token);
    let origin = format!("http://127.0.0.1:{}", port.expect("checked port"));
    Ok((url, origin))
}

fn navigation_allowed(accepted_origin: Option<&str>, url: &tauri::Url) -> bool {
    match accepted_origin {
        Some(origin) => {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_some()
                && format!("http://127.0.0.1:{}", url.port().expect("checked port")) == origin
        }
        None => {
            url.scheme() == "data"
                || url.as_str() == "about:blank"
                || (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                || (matches!(url.scheme(), "http" | "https")
                    && url.host_str() == Some("tauri.localhost"))
        }
    }
}

fn stop_service(app: &tauri::AppHandle) {
    let service = app.state::<LocalService>();
    service.stopping.store(true, Ordering::SeqCst);
    if let Ok(mut child) = service.child.lock() {
        if let Some(child) = child.take() {
            let _ = child.kill();
        }
    };
}

fn take_restart_request(value: &AtomicBool) -> bool {
    value.swap(false, Ordering::SeqCst)
}

fn finish_service_exit(app: &tauri::AppHandle) {
    if take_restart_request(&app.state::<LocalService>().restart_after_shutdown) {
        app.request_restart();
    } else {
        app.exit(0);
    }
}

fn request_close(app: &tauri::AppHandle, accept_existing: bool) -> bool {
    let service = app.state::<LocalService>();
    if service.phase.load(Ordering::SeqCst) != READY || service.stopping.load(Ordering::SeqCst) {
        return false;
    }
    let Some(window) = app.get_webview_window("main") else {
        return false;
    };
    let attempt_id = {
        let mut current = service
            .close_attempt
            .lock()
            .expect("local service state poisoned");
        if current.is_some() {
            return accept_existing;
        }
        let attempt_id = service.next_close_attempt.fetch_add(1, Ordering::SeqCst);
        current.replace(attempt_id);
        attempt_id
    };
    let request_script = format!(
        "window.dispatchEvent(new CustomEvent('zhiye:close-requested', {{ detail: {{ attemptId: '{attempt_id}' }} }}))"
    );
    if window.eval(&request_script).is_err() {
        let mut current = service
            .close_attempt
            .lock()
            .expect("local service state poisoned");
        if *current == Some(attempt_id) {
            current.take();
        }
        return false;
    }

    let timeout_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_TIMEOUT);
        let service = timeout_handle.state::<LocalService>();
        let timed_out = {
            let mut current = service
                .close_attempt
                .lock()
                .expect("local service state poisoned");
            if !service.stopping.load(Ordering::SeqCst) && *current == Some(attempt_id) {
                current.take();
                true
            } else {
                false
            }
        };
        if timed_out {
            timeout_handle
                .state::<LocalService>()
                .restart_after_shutdown
                .store(false, Ordering::SeqCst);
            if let Some(window) = timeout_handle.get_webview_window("main") {
                let timeout_script = format!(
                    "window.dispatchEvent(new CustomEvent('zhiye:close-timeout', {{ detail: {{ attemptId: '{attempt_id}' }} }}))"
                );
                let _ = window.eval(&timeout_script);
            }
        }
    });
    true
}

fn shutdown_sidecar(app: &tauri::AppHandle, attempt_id: u64) {
    let service = app.state::<LocalService>();
    {
        let mut current = service
            .close_attempt
            .lock()
            .expect("local service state poisoned");
        if *current != Some(attempt_id)
            || service
                .stopping
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return;
        }
        current.take();
    }
    let write_result = service
        .child
        .lock()
        .expect("local service state poisoned")
        .as_mut()
        .ok_or_else(|| "local service process is unavailable".to_owned())
        .and_then(|child| {
            child
                .write(b"ZHIYE_SHUTDOWN\n")
                .map_err(|error| error.to_string())
        });
    if write_result.is_err() {
        stop_service(app);
        finish_service_exit(app);
        return;
    }

    let timeout_handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_TIMEOUT);
        if timeout_handle
            .state::<LocalService>()
            .child
            .lock()
            .map(|child| child.is_some())
            .unwrap_or(false)
        {
            stop_service(&timeout_handle);
            finish_service_exit(&timeout_handle);
        }
    });
}

#[tauri::command]
fn restart_after_update(app: tauri::AppHandle) -> Result<(), String> {
    let service = app.state::<LocalService>();
    if service
        .restart_after_shutdown
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("更新重启已在进行。".to_owned());
    }
    if request_close(&app, false) {
        Ok(())
    } else {
        service
            .restart_after_shutdown
            .store(false, Ordering::SeqCst);
        Err("应用尚未准备好安全重启。".to_owned())
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn data_url(html: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut url = String::with_capacity(html.len() * 2);
    url.push_str("data:text/html;charset=utf-8,");

    for byte in html.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            url.push(char::from(byte));
        } else {
            url.push('%');
            url.push(char::from(HEX[(byte >> 4) as usize]));
            url.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }

    url
}

fn show_startup_error(app: &tauri::AppHandle, title: &str, message: &str, details: &str) {
    #[cfg(debug_assertions)]
    external::write_smoke_error(app, details);
    let title = escape_html(title);
    let message = escape_html(message);
    let details = escape_html(if details.trim().is_empty() {
        "未收到更多诊断信息。"
    } else {
        details.trim()
    });
    let html = format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{ color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f4ef; color: #25231f; }}
    main {{ width: min(640px, calc(100vw - 64px)); padding: 40px; border: 1px solid #ded9cf; border-radius: 18px; background: #fffdf8; box-shadow: 0 18px 55px rgba(48, 42, 32, .08); }}
    small {{ color: #8b5e34; font-weight: 700; letter-spacing: .08em; }}
    h1 {{ margin: 12px 0; font-size: 28px; }}
    p {{ margin: 0; color: #5c574f; line-height: 1.7; }}
    details {{ margin-top: 24px; color: #6b655c; }}
    summary {{ cursor: pointer; }}
    pre {{ margin-top: 12px; padding: 16px; overflow: auto; border-radius: 10px; background: #f1eee8; white-space: pre-wrap; word-break: break-word; font-size: 12px; }}
  </style>
</head>
<body>
  <main>
    <small>织页启动诊断</small>
    <h1>{title}</h1>
    <p>{message}</p>
    <details><summary>查看技术信息</summary><pre>{details}</pre></details>
  </main>
</body>
</html>"#
    );

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("织页 · {title}"));
        if let Ok(url) = tauri::Url::parse(&data_url(&html)) {
            let _ = window.navigate(url);
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn append_stderr(app: &tauri::AppHandle, output: &str) {
    if let Ok(mut buffer) = app.state::<LocalService>().stderr.lock() {
        for character in output.chars() {
            if buffer.len() + character.len_utf8() > STDERR_LIMIT {
                break;
            }
            buffer.push(character);
        }
    }
}

fn fail_service(app: &tauri::AppHandle, reason: &str) {
    let service = app.state::<LocalService>();
    if service.stopping.load(Ordering::SeqCst)
        || service.phase.swap(FAILED, Ordering::SeqCst) == FAILED
    {
        return;
    }
    if let Ok(mut origin) = service.accepted_origin.lock() {
        origin.take();
    }

    let captured = service
        .stderr
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let details = if captured.trim().is_empty() {
        reason.to_owned()
    } else {
        format!("{reason}\n\n{captured}")
    };

    if details
        .to_ascii_lowercase()
        .contains("knowledge base is already open")
    {
        show_startup_error(
            app,
            "知识库已在另一进程中打开",
            "数据目录正被另一个织页进程使用。请关闭其他织页实例后重新打开。",
            &details,
        );
    } else {
        show_startup_error(
            app,
            "本地服务启动失败",
            "织页无法启动本地知识服务。请重新打开应用；若问题持续，请展开下方技术信息。",
            &details,
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let updater_configured = context.config().plugins.0.contains_key("updater");
    let accepted_origin = Arc::new(Mutex::new(None));
    let navigation_origin = accepted_origin.clone();
    let builder = tauri::Builder::default()
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("navigation-guard")
                .on_navigation(move |webview, url| {
                    let origin = navigation_origin.lock().ok();
                    webview.label() != "main"
                        || navigation_allowed(origin.as_deref().and_then(Option::as_deref), url)
                })
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            external::focus_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init());
    let builder = if updater_configured {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    let app = builder
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            external::take_external_intents,
            external::read_external_text,
            external::read_external_binary,
            external::discard_external_tokens,
            keychain::llm_keychain_status,
            keychain::set_llm_api_key,
            keychain::delete_llm_api_key,
            launcher::choose_data_directory,
            restart_after_update,
        ])
        .manage(external::ExternalState::default())
        .manage(LocalService {
            child: Mutex::new(None),
            phase: AtomicU8::new(STARTING),
            stderr: Mutex::new(String::new()),
            stopping: AtomicBool::new(false),
            restart_after_shutdown: AtomicBool::new(false),
            close_attempt: Mutex::new(None),
            next_close_attempt: AtomicU64::new(1),
            accepted_origin,
        })
        .setup(|app| {
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                external::enqueue_deep_links(app.handle(), &urls);
            }
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                external::enqueue_deep_links(&deep_link_handle, &event.urls());
                external::focus_main(&deep_link_handle);
            });

            let resource_dir = match app.path().resource_dir() {
                Ok(path) => path,
                Err(error) => {
                    show_startup_error(
                        app.handle(),
                        "无法定位应用资源",
                        "织页无法找到随应用提供的资源。请重新安装应用。",
                        &error.to_string(),
                    );
                    return Ok(());
                }
            };
            let default_data_dir = match app.path().app_data_dir() {
                Ok(path) => path,
                Err(error) => {
                    show_startup_error(
                        app.handle(),
                        "无法定位数据目录",
                        "织页无法定位本地知识库目录。请重新打开应用。",
                        &error.to_string(),
                    );
                    return Ok(());
                }
            };
            let data_dir = match launcher::data_directory(app.handle(), default_data_dir) {
                Ok(path) => path,
                Err(error) => {
                    show_startup_error(
                        app.handle(),
                        "无法读取数据目录设置",
                        "织页无法确认本地知识库位置。请修复桌面启动配置后重试。",
                        &error,
                    );
                    return Ok(());
                }
            };
            if let Err(error) = fs::create_dir_all(&data_dir) {
                show_startup_error(
                    app.handle(),
                    "无法准备数据目录",
                    "织页无法创建或访问本地知识库目录。请检查目录权限后重试。",
                    &error.to_string(),
                );
                return Ok(());
            }

            let runtime_dir = resource_dir.join("runtime");
            let server_entry = runtime_dir.join("dist-server/server/index.js");
            let static_dir = runtime_dir.join("dist");
            let browsers_dir = runtime_dir.join("browsers");

            #[cfg(debug_assertions)]
            if let Err(error) = keychain::seed_smoke_api_key() {
                show_startup_error(
                    app.handle(),
                    "无法准备钥匙串测试",
                    "织页无法准备隔离的测试密钥。",
                    &error,
                );
                return Ok(());
            }

            let command = match app.shell().sidecar("node") {
                Ok(command) => {
                    let mut command = command
                        .arg(server_entry)
                        .env("KB_DATA_DIR", data_dir)
                        .env("KB_STATIC_DIR", static_dir)
                        .env("KB_DESKTOP", "1")
                        .env("PLAYWRIGHT_BROWSERS_PATH", browsers_dir);
                    for (name, value) in SIDECAR_ENVIRONMENT {
                        command = command.env(name, value);
                    }
                    match keychain::load_api_key() {
                        Ok(Some(api_key)) => command.env("ZHIYE_LLM_API_KEY", api_key),
                        _ => command.env("ZHIYE_LLM_API_KEY", ""),
                    }
                }
                Err(error) => {
                    show_startup_error(
                        app.handle(),
                        "本地服务不可用",
                        "织页未找到随应用提供的本地服务。请重新安装应用。",
                        &error.to_string(),
                    );
                    return Ok(());
                }
            };

            let (mut events, child) = match command.spawn() {
                Ok(result) => result,
                Err(error) => {
                    show_startup_error(
                        app.handle(),
                        "本地服务无法启动",
                        "织页无法启动随应用提供的本地服务。请重新安装或重新打开应用。",
                        &error.to_string(),
                    );
                    return Ok(());
                }
            };
            app.state::<LocalService>()
                .child
                .lock()
                .expect("local service state poisoned")
                .replace(child);

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            let output = String::from_utf8_lossy(&bytes);
                            for line in output.lines() {
                                if let Some(raw_url) = line.strip_prefix("ZHIYE_READY ") {
                                    match (
                                        parse_ready_url(raw_url),
                                        handle.get_webview_window("main"),
                                    ) {
                                        (Ok((url, origin)), Some(window)) => {
                                            if handle
                                                .state::<LocalService>()
                                                .phase
                                                .compare_exchange(
                                                    STARTING,
                                                    READY,
                                                    Ordering::SeqCst,
                                                    Ordering::SeqCst,
                                                )
                                                .is_ok()
                                            {
                                                handle
                                                    .state::<LocalService>()
                                                    .accepted_origin
                                                    .lock()
                                                    .expect("local service state poisoned")
                                                    .replace(origin);
                                                #[cfg(debug_assertions)]
                                                external::write_smoke_stage(
                                                    &handle,
                                                    "service-ready",
                                                );
                                                if let Err(error) = window.navigate(url) {
                                                    handle
                                                        .state::<LocalService>()
                                                        .accepted_origin
                                                        .lock()
                                                        .expect("local service state poisoned")
                                                        .take();
                                                    fail_service(
                                                        &handle,
                                                        &format!("无法打开本地服务页面：{error}"),
                                                    );
                                                } else {
                                                    let _ = window.show();
                                                    let _ = window.set_focus();
                                                }
                                            }
                                        }
                                        (Err(error), _) => fail_service(
                                            &handle,
                                            &format!("本地服务返回了无效地址：{error}"),
                                        ),
                                        (_, None) => fail_service(&handle, "未找到应用主窗口。"),
                                    }
                                } else if let Some(raw_attempt) =
                                    line.strip_prefix("ZHIYE_CLOSE_READY ")
                                {
                                    if let Ok(attempt_id) = raw_attempt.trim().parse::<u64>() {
                                        shutdown_sidecar(&handle, attempt_id);
                                    }
                                }
                            }
                        }
                        CommandEvent::Stderr(bytes) => {
                            let output = String::from_utf8_lossy(&bytes);
                            eprintln!("zhiye service: {output}");
                            append_stderr(&handle, &output);
                        }
                        CommandEvent::Error(error) => {
                            eprintln!("zhiye service error: {error}");
                            fail_service(&handle, &format!("本地服务进程错误：{error}"));
                            break;
                        }
                        CommandEvent::Terminated(payload) => {
                            let service = handle.state::<LocalService>();
                            if service.stopping.load(Ordering::SeqCst) {
                                service
                                    .child
                                    .lock()
                                    .expect("local service state poisoned")
                                    .take();
                                finish_service_exit(&handle);
                            } else {
                                fail_service(&handle, &format!("本地服务进程已退出：{payload:?}"));
                            }
                            break;
                        }
                        _ => {}
                    }
                }

                fail_service(&handle, "本地服务事件通道已关闭。");
            });

            let timeout_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(STARTUP_TIMEOUT);
                let service = timeout_handle.state::<LocalService>();
                if !service.stopping.load(Ordering::SeqCst)
                    && service
                        .phase
                        .compare_exchange(STARTING, FAILED, Ordering::SeqCst, Ordering::SeqCst)
                        .is_ok()
                {
                    let captured = service
                        .stderr
                        .lock()
                        .map(|value| value.clone())
                        .unwrap_or_default();
                    show_startup_error(
                        &timeout_handle,
                        "本地服务启动超时",
                        "织页等待本地知识服务超过 20 秒。请重新打开应用。",
                        &captured,
                    );
                    stop_service(&timeout_handle);
                }
            });

            Ok(())
        })
        .build(context)
        .expect("failed to build the Zhiye desktop app");

    app.run(|handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => external::enqueue_file_urls(handle, &urls),
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }),
            ..
        } if label == "main" => external::enqueue_paths(handle, paths),
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            if request_close(handle, true) {
                api.prevent_close();
            }
        }
        RunEvent::ExitRequested { api, .. } => {
            if request_close(handle, true) {
                api.prevent_exit();
            }
        }
        RunEvent::Exit => stop_service(handle),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_url_and_navigation_stay_on_the_authenticated_service_origin() {
        let (ready, origin) =
            parse_ready_url("http://127.0.0.1:43123/launch?token=single-nonempty-token")
                .expect("valid READY URL");
        assert_eq!(origin, "http://127.0.0.1:43123");
        assert!(navigation_allowed(Some(&origin), &ready));
        assert!(navigation_allowed(
            Some(&origin),
            &tauri::Url::parse("http://127.0.0.1:43123/library?q=local").unwrap()
        ));
        assert!(!navigation_allowed(
            Some(&origin),
            &tauri::Url::parse("http://127.0.0.1:43124/").unwrap()
        ));
        assert!(!navigation_allowed(
            Some(&origin),
            &tauri::Url::parse("http://user@127.0.0.1:43123/").unwrap()
        ));
        assert!(navigation_allowed(
            None,
            &tauri::Url::parse("data:text/html,startup-error").unwrap()
        ));
        assert!(!navigation_allowed(
            Some(&origin),
            &tauri::Url::parse("data:text/html,untrusted").unwrap()
        ));

        for invalid in [
            "https://127.0.0.1:43123/launch?token=x",
            "http://localhost:43123/launch?token=x",
            "http://127.0.0.1/launch?token=x",
            "http://127.0.0.1:0/launch?token=x",
            "http://127.0.0.1:43123/other?token=x",
            "http://127.0.0.1:43123/launch?token=",
            "http://127.0.0.1:43123/launch?token=x&extra=y",
            "http://user@127.0.0.1:43123/launch?token=x",
            "http://127.0.0.1:43123/launch?token=x#fragment",
        ] {
            assert!(parse_ready_url(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn desktop_sidecar_forces_production_auth_and_random_port() {
        assert_eq!(
            SIDECAR_ENVIRONMENT,
            [
                ("KB_DEV", "0"),
                ("KB_PORT", "0"),
                ("KB_BOOTSTRAP_TOKEN", ""),
                ("NODE_ENV", "production"),
            ]
        );
    }

    #[test]
    fn update_restart_request_is_consumed_once() {
        let requested = AtomicBool::new(true);
        assert!(take_restart_request(&requested));
        assert!(!take_restart_request(&requested));
    }
}
