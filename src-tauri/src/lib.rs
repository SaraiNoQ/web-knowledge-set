use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const STARTING: u8 = 0;
const READY: u8 = 1;
const FAILED: u8 = 2;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const STDERR_LIMIT: usize = 8 * 1024;

struct LocalService {
    child: Mutex<Option<CommandChild>>,
    phase: AtomicU8,
    stderr: Mutex<String>,
    stopping: AtomicBool,
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.set_focus();
                }
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(LocalService {
            child: Mutex::new(None),
            phase: AtomicU8::new(STARTING),
            stderr: Mutex::new(String::new()),
            stopping: AtomicBool::new(false),
        })
        .setup(|app| {
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
            let data_dir = match app.path().app_data_dir() {
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

            let command = match app.shell().sidecar("node") {
                Ok(command) => command
                    .arg(server_entry)
                    .env("KB_DATA_DIR", data_dir)
                    .env("KB_STATIC_DIR", static_dir)
                    .env("PLAYWRIGHT_BROWSERS_PATH", browsers_dir),
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
                                        tauri::Url::parse(raw_url.trim()),
                                        handle.get_webview_window("main"),
                                    ) {
                                        (Ok(url), Some(window)) => {
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
                                                if let Err(error) = window.navigate(url) {
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
                            fail_service(&handle, &format!("本地服务进程已退出：{payload:?}"));
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
        .build(tauri::generate_context!())
        .expect("failed to build the Zhiye desktop app");

    app.run(|handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            stop_service(handle);
        }
    });
}
