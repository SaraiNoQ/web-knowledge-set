use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::Read;
#[cfg(debug_assertions)]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;
use uuid::Uuid;

const MAX_CAPTURE_URL_BYTES: usize = 4 * 1024;
const MAX_DEEP_LINK_BYTES: usize = 8 * 1024;
const MAX_CAPTURE_INTENTS: usize = 64;
const MAX_MARKDOWN_FILES: usize = 100;
const MAX_TEXT_BYTES: usize = 10 * 1024 * 1024;
const MAX_BUNDLE_BYTES: usize = 100 * 1024 * 1024;
const MAX_SCANNED_ENTRIES: usize = 10_000;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum ExternalIntent {
    Capture { url: String },
    Markdown { token: String, name: String },
    Bookmarks { token: String, name: String },
    Bundle { token: String, name: String },
    Error { message: String },
}

impl ExternalIntent {
    fn is_file(&self) -> bool {
        !matches!(self, Self::Capture { .. })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileKind {
    Markdown,
    Bookmarks,
    Bundle,
}

#[derive(Debug)]
struct ExternalFile {
    kind: FileKind,
    name: String,
    bytes: Vec<u8>,
}

#[derive(Serialize)]
pub(crate) struct ExternalText {
    name: String,
    content: String,
}

#[derive(Default)]
pub(crate) struct ExternalState {
    pending: Mutex<VecDeque<ExternalIntent>>,
    files: Mutex<HashMap<String, ExternalFile>>,
    file_generation: AtomicU64,
    file_loading: Mutex<()>,
}

impl ExternalState {
    fn push_capture(&self, url: String) -> bool {
        let mut pending = self.pending.lock().expect("external intent state poisoned");
        if pending
            .iter()
            .filter(|intent| matches!(intent, ExternalIntent::Capture { .. }))
            .count()
            >= MAX_CAPTURE_INTENTS
        {
            return false;
        }
        pending.push_back(ExternalIntent::Capture { url });
        true
    }

    fn finish_file_batch(
        &self,
        generation: u64,
        result: Result<Vec<ExternalFile>, String>,
    ) -> bool {
        let mut files = self.files.lock().expect("external file state poisoned");
        let mut pending = self.pending.lock().expect("external intent state poisoned");
        if !self.is_current_file_batch(generation) {
            return false;
        }
        files.clear();
        pending.retain(|intent| !intent.is_file());
        match result {
            Ok(loaded) => {
                for file in loaded {
                    let token = Uuid::new_v4().to_string();
                    let intent = match file.kind {
                        FileKind::Markdown => ExternalIntent::Markdown {
                            token: token.clone(),
                            name: file.name.clone(),
                        },
                        FileKind::Bookmarks => ExternalIntent::Bookmarks {
                            token: token.clone(),
                            name: file.name.clone(),
                        },
                        FileKind::Bundle => ExternalIntent::Bundle {
                            token: token.clone(),
                            name: file.name.clone(),
                        },
                    };
                    files.insert(token, file);
                    pending.push_back(intent);
                }
            }
            Err(message) => pending.push_back(ExternalIntent::Error { message }),
        }
        true
    }

    fn drain(&self) -> Vec<ExternalIntent> {
        self.pending
            .lock()
            .expect("external intent state poisoned")
            .drain(..)
            .collect()
    }

    fn begin_file_batch(&self) -> u64 {
        let generation = self.file_generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.files
            .lock()
            .expect("external file state poisoned")
            .clear();
        self.pending
            .lock()
            .expect("external intent state poisoned")
            .retain(|intent| !intent.is_file());
        generation
    }

    fn is_current_file_batch(&self, generation: u64) -> bool {
        self.file_generation.load(Ordering::SeqCst) == generation
    }

    fn take_file(&self, token: &str, expected: FileKind) -> Result<ExternalFile, String> {
        let mut files = self.files.lock().map_err(|_| "外部文件状态不可用")?;
        if files.get(token).map(|file| file.kind) != Some(expected) {
            return Err("文件令牌无效或已使用".to_owned());
        }
        files
            .remove(token)
            .ok_or_else(|| "文件令牌无效或已使用".to_owned())
    }
}

pub(crate) fn parse_capture_deep_link(url: &tauri::Url) -> Option<String> {
    if url.as_str().len() > MAX_DEEP_LINK_BYTES
        || url.scheme() != "zhiye"
        || url.host_str() != Some("capture")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !matches!(url.path(), "" | "/")
        || url.fragment().is_some()
    {
        return None;
    }
    let mut query = url.query_pairs();
    let (key, value) = query.next()?;
    if key != "url" || query.next().is_some() || value.len() > MAX_CAPTURE_URL_BYTES {
        return None;
    }
    let target = tauri::Url::parse(&value).ok()?;
    if !matches!(target.scheme(), "http" | "https")
        || target.host_str().is_none()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.port() == Some(0)
    {
        return None;
    }
    Some(target.to_string())
}

pub(crate) fn enqueue_deep_links(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let state = app.state::<ExternalState>();
    let added = urls
        .iter()
        .filter_map(parse_capture_deep_link)
        .fold(false, |added, url| state.push_capture(url) || added);
    if added {
        #[cfg(debug_assertions)]
        write_smoke_stage(app, "received");
        notify(app);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn enqueue_file_urls(app: &tauri::AppHandle, urls: &[tauri::Url]) {
    let paths = urls
        .iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .collect::<Vec<_>>();
    enqueue_paths(app, paths);
}

pub(crate) fn enqueue_paths(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let generation = app.state::<ExternalState>().begin_file_batch();
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<ExternalState>();
        let _loading = state
            .file_loading
            .lock()
            .expect("external file loader poisoned");
        if !state.is_current_file_batch(generation) {
            return;
        }
        let result = load_paths(&paths);
        #[cfg(debug_assertions)]
        let smoke_names = result
            .as_ref()
            .ok()
            .map(|files| files.iter().map(|file| file.name.clone()).collect::<Vec<_>>());
        if state.finish_file_batch(generation, result) {
            #[cfg(debug_assertions)]
            write_smoke_marker(&handle, smoke_names);
            notify(&handle);
            focus_main(&handle);
        }
    });
}

#[cfg(debug_assertions)]
fn write_smoke_marker(app: &tauri::AppHandle, names: Option<Vec<String>>) {
    if std::env::var("ZHIYE_DESKTOP_SMOKE").as_deref() != Ok("1") {
        return;
    }
    if let (Ok(data_dir), Some(names)) = (app.path().app_data_dir(), names) {
        let _ = fs::write(data_dir.join(".desktop-smoke-files"), names.join("\n"));
    }
}

#[cfg(debug_assertions)]
pub(crate) fn write_smoke_stage(app: &tauri::AppHandle, stage: &str) {
    if std::env::var("ZHIYE_DESKTOP_SMOKE").as_deref() == Ok("1") {
        if let Ok(data_dir) = app.path().app_data_dir() {
            let _ = fs::create_dir_all(&data_dir);
            if let Ok(mut marker) = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(data_dir.join(".desktop-smoke-intent"))
            {
                let _ = writeln!(marker, "{stage}");
            }
        }
    }
}

pub(crate) fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn notify(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.dispatchEvent(new Event('zhiye:external-intents-ready'))");
    }
}

fn kind(path: &Path) -> Option<FileKind> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "md" | "markdown" => Some(FileKind::Markdown),
        "html" | "htm" => Some(FileKind::Bookmarks),
        "zip" => Some(FileKind::Bundle),
        _ => None,
    }
}

fn collect_paths(
    path: &Path,
    logical: &Path,
    markdown_only: bool,
    files: &mut Vec<(PathBuf, String)>,
    scanned: &mut usize,
) -> Result<(), String> {
    *scanned += 1;
    if *scanned > MAX_SCANNED_ENTRIES {
        return Err("拖入目录条目过多".to_owned());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "无法读取拖入路径".to_owned())?;
    if metadata.file_type().is_symlink() {
        return Err("不支持符号链接".to_owned());
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|_| "无法读取拖入目录".to_owned())? {
            let entry = entry.map_err(|_| "无法读取拖入目录".to_owned())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "文件名必须为 UTF-8".to_owned())?;
            collect_paths(
                &entry.path(),
                &logical.join(name),
                markdown_only,
                files,
                scanned,
            )?;
        }
    } else if metadata.is_file()
        && kind(path).is_some_and(|kind| !markdown_only || kind == FileKind::Markdown)
    {
        let name = logical
            .to_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "文件名必须为 UTF-8".to_owned())?;
        files.push((path.to_path_buf(), name.replace('\\', "/")));
    }
    Ok(())
}

fn load_paths(roots: &[PathBuf]) -> Result<Vec<ExternalFile>, String> {
    let mut candidates = Vec::new();
    let mut scanned = 0;
    for root in roots {
        let name = root
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "文件名必须为 UTF-8".to_owned())?;
        let markdown_only = fs::symlink_metadata(root)
            .map_err(|_| "无法读取拖入路径".to_owned())?
            .is_dir();
        collect_paths(
            root,
            Path::new(name),
            markdown_only,
            &mut candidates,
            &mut scanned,
        )?;
    }
    if candidates.is_empty() {
        return Err("没有可导入的文件".to_owned());
    }
    let expected = kind(&candidates[0].0).expect("filtered candidate has a kind");
    if candidates.iter().any(|(path, _)| kind(path) != Some(expected)) {
        return Err("一次只能导入一种文件类型".to_owned());
    }
    if (expected == FileKind::Markdown && candidates.len() > MAX_MARKDOWN_FILES)
        || (expected != FileKind::Markdown && candidates.len() != 1)
    {
        return Err(if expected == FileKind::Markdown {
            format!("一次最多导入 {MAX_MARKDOWN_FILES} 个 Markdown 文件")
        } else {
            "一次只能导入一个书签或知识包文件".to_owned()
        });
    }

    let limit = if expected == FileKind::Bundle {
        MAX_BUNDLE_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    let mut total = 0usize;
    let mut loaded = Vec::with_capacity(candidates.len());
    for (path, name) in candidates {
        let remaining = limit
            .checked_sub(total)
            .ok_or_else(|| "导入文件超过大小限制".to_owned())?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "无法读取导入文件".to_owned())?;
        if metadata.file_type().is_symlink() {
            return Err("不支持符号链接".to_owned());
        }
        if metadata.len() > remaining as u64 {
            return Err(if expected == FileKind::Bundle {
                "织页知识包不能超过 100 MiB".to_owned()
            } else {
                "导入文件合计不能超过 10 MiB".to_owned()
            });
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        fs::File::open(path)
            .map_err(|_| "无法读取导入文件".to_owned())?
            .take(remaining as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "无法读取导入文件".to_owned())?;
        total = total
            .checked_add(bytes.len())
            .filter(|total| *total <= limit)
            .ok_or_else(|| {
                if expected == FileKind::Bundle {
                    "织页知识包不能超过 100 MiB".to_owned()
                } else {
                    "导入文件合计不能超过 10 MiB".to_owned()
                }
            })?;
        if expected != FileKind::Bundle && std::str::from_utf8(&bytes).is_err() {
            return Err("只支持 UTF-8 文本文件".to_owned());
        }
        loaded.push(ExternalFile {
            kind: expected,
            name,
            bytes,
        });
    }
    Ok(loaded)
}

#[tauri::command]
pub(crate) fn take_external_intents(
    app: tauri::AppHandle,
    state: tauri::State<'_, ExternalState>,
) -> Vec<ExternalIntent> {
    let intents = state.drain();
    #[cfg(debug_assertions)]
    if intents
        .iter()
        .any(|intent| matches!(intent, ExternalIntent::Capture { .. }))
    {
        write_smoke_stage(&app, "drained");
    }
    intents
}

#[tauri::command]
pub(crate) fn read_external_text(
    token: String,
    state: tauri::State<'_, ExternalState>,
) -> Result<ExternalText, String> {
    let mut files = state.files.lock().map_err(|_| "外部文件状态不可用")?;
    let expected = match files.get(&token).map(|file| file.kind) {
        Some(FileKind::Markdown) => FileKind::Markdown,
        Some(FileKind::Bookmarks) => FileKind::Bookmarks,
        _ => return Err("文件令牌无效或已使用".to_owned()),
    };
    let file = files
        .remove(&token)
        .filter(|file| file.kind == expected)
        .ok_or_else(|| "文件令牌无效或已使用".to_owned())?;
    Ok(ExternalText {
        name: file.name,
        content: String::from_utf8(file.bytes).map_err(|_| "文件不是 UTF-8 文本".to_owned())?,
    })
}

#[tauri::command]
pub(crate) fn read_external_binary(
    token: String,
    state: tauri::State<'_, ExternalState>,
) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(
        state.take_file(&token, FileKind::Bundle)?.bytes,
    ))
}

#[tauri::command]
pub(crate) fn discard_external_tokens(
    tokens: Vec<String>,
    state: tauri::State<'_, ExternalState>,
) -> Result<(), String> {
    if tokens.len() > MAX_MARKDOWN_FILES + 2 {
        return Err("待清理的文件令牌过多".to_owned());
    }
    let mut files = state.files.lock().map_err(|_| "外部文件状态不可用")?;
    for token in tokens {
        files.remove(&token);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_links_are_strict_and_queue_is_atomic() {
        let valid = tauri::Url::parse(
            "zhiye://capture?url=https%3A%2F%2Fexample.com%2Farticle%3Fa%3D1",
        )
        .unwrap();
        assert_eq!(
            parse_capture_deep_link(&valid).as_deref(),
            Some("https://example.com/article?a=1")
        );
        for invalid in [
            "zhiye://delete?url=https%3A%2F%2Fexample.com",
            "zhiye://capture/other?url=https%3A%2F%2Fexample.com",
            "zhiye://capture?url=file%3A%2F%2F%2Ftmp%2Fsecret",
            "zhiye://capture?url=https%3A%2F%2Fuser%3Apass%40example.com",
            "zhiye://capture?url=https%3A%2F%2Fexample.com&command=delete",
            "zhiye://capture?url=http%3A%2F%2Fexample.com%3A0",
        ] {
            assert!(parse_capture_deep_link(&tauri::Url::parse(invalid).unwrap()).is_none());
        }

        let state = ExternalState::default();
        assert!(state.push_capture("https://example.com".to_owned()));
        assert_eq!(state.drain().len(), 1);
        assert!(state.drain().is_empty());
        let first = state.begin_file_batch();
        let second = state.begin_file_batch();
        assert!(!state.is_current_file_batch(first));
        assert!(state.is_current_file_batch(second));
    }

    #[test]
    fn files_are_bounded_before_reading_and_must_be_utf8() {
        let root = std::env::temp_dir().join(format!("zhiye-external-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let valid = root.join("valid.md");
        fs::write(&valid, "# 本地笔记").unwrap();
        fs::write(root.join("ignored.zip"), b"not a bundle").unwrap();
        let loaded = load_paths(std::slice::from_ref(&root)).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].name.ends_with("/valid.md"));

        #[cfg(unix)]
        {
            let linked = root.join("linked.md");
            std::os::unix::fs::symlink(&valid, &linked).unwrap();
            assert_eq!(
                load_paths(std::slice::from_ref(&linked)).unwrap_err(),
                "不支持符号链接"
            );
            fs::remove_file(linked).unwrap();
        }

        let invalid = root.join("invalid.md");
        fs::write(&invalid, [0xff, 0xfe]).unwrap();
        assert_eq!(
            load_paths(std::slice::from_ref(&invalid)).unwrap_err(),
            "只支持 UTF-8 文本文件"
        );

        let oversized = root.join("oversized.md");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_TEXT_BYTES as u64 + 1)
            .unwrap();
        assert_eq!(
            load_paths(std::slice::from_ref(&oversized)).unwrap_err(),
            "导入文件合计不能超过 10 MiB"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
