use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

#[cfg(target_os = "macos")]
use tauri_plugin_dialog::{DialogExt, FilePath};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LauncherConfig {
    version: u8,
    data_dir: PathBuf,
}

const LEGACY_IDENTIFIER: &str = "dev.local.zhiye";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryChoice {
    configured: bool,
}

fn launcher_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_config = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法定位桌面启动配置。".to_string())?;
    let name = app_config
        .file_name()
        .ok_or_else(|| "桌面启动配置路径无效。".to_string())?
        .to_string_lossy();
    Ok(app_config
        .with_file_name(format!("{name}-launcher"))
        .join("launcher.json"))
}

fn legacy_launcher_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_config = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法定位桌面启动配置。".to_string())?;
    Ok(app_config
        .with_file_name(format!("{LEGACY_IDENTIFIER}-launcher"))
        .join("launcher.json"))
}

fn validate_directory(path: &Path, must_be_empty: bool) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "所选文件夹无法访问。".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("请选择真实的本地文件夹。".to_string());
    }
    if must_be_empty
        && fs::read_dir(path)
            .map_err(|_| "所选文件夹无法读取。".to_string())?
            .next()
            .is_some()
    {
        return Err("请选择一个空文件夹。已有知识库请通过完整备份恢复迁移。".to_string());
    }
    fs::canonicalize(path).map_err(|_| "所选文件夹无法解析。".to_string())
}

fn companion_paths(data_dir: &Path) -> Vec<PathBuf> {
    let Some(name) = data_dir.file_name() else {
        return Vec::new();
    };
    let name = name.to_string_lossy();
    vec![
        data_dir.with_file_name(format!("{name}-backups")),
        data_dir.with_file_name(format!("{name}-diagnostics")),
        data_dir.with_file_name(format!(".{name}.zhiye.lock")),
    ]
}

fn related_paths(data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![data_dir.to_path_buf()];
    paths.extend(companion_paths(data_dir));
    paths
}

fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

#[derive(Clone, Copy)]
struct DataState {
    data: bool,
    companions: bool,
}

fn directory_has_entries(path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法检查旧版或正式数据目录。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("旧版或正式数据路径不安全。".to_string());
    }
    fs::read_dir(path)
        .map_err(|_| "无法读取旧版或正式数据目录。".to_string())?
        .next()
        .transpose()
        .map(|entry| entry.is_some())
        .map_err(|_| "无法读取旧版或正式数据目录。".to_string())
}

fn regular_file_exists(path: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法检查旧版或正式数据锁。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("旧版或正式数据锁路径不安全。".to_string());
    }
    Ok(true)
}

fn data_state(data_dir: &Path) -> Result<DataState, String> {
    let companions = companion_paths(data_dir);
    if companions.len() != 3 {
        return Err("数据目录路径无效。".to_string());
    }
    let backups = directory_has_entries(&companions[0])?;
    let diagnostics = directory_has_entries(&companions[1])?;
    let lock = regular_file_exists(&companions[2])?;
    Ok(DataState {
        data: directory_has_entries(data_dir)?,
        companions: backups || diagnostics || lock,
    })
}

fn ensure_complete_state(state: DataState) -> Result<(), String> {
    if !state.data && state.companions {
        return Err(
            "检测到没有主数据库的旧版或正式备份、诊断或锁文件；已停止启动以避免打开空知识库。"
                .to_string(),
        );
    }
    Ok(())
}

fn same_location(left: &Path, right: &Path) -> bool {
    fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf())
        == fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf())
}

fn validate_migration_target(
    target: &Path,
    default: &Path,
    launcher: &Path,
    legacy_launcher: &Path,
) -> Result<(), String> {
    if same_location(target, default) {
        return Ok(());
    }
    let launcher_root = launcher
        .parent()
        .ok_or_else(|| "桌面启动配置路径无效。".to_string())
        .map(|path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))?;
    let legacy_launcher_root = legacy_launcher
        .parent()
        .ok_or_else(|| "旧版桌面启动配置路径无效。".to_string())
        .map(|path| fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()))?;
    let candidate = related_paths(target);
    let protected = related_paths(default);
    if candidate
        .iter()
        .any(|left| protected.iter().any(|right| overlaps(left, right)))
        || candidate
            .iter()
            .any(|path| overlaps(path, &launcher_root) || overlaps(path, &legacy_launcher_root))
    {
        return Err("旧版数据目录与正式数据或启动配置目录冲突。".to_string());
    }
    Ok(())
}

fn read_launcher(path: &Path) -> Result<Option<PathBuf>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("桌面启动配置无法读取。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err("桌面启动配置不安全或已损坏。".to_string());
    }
    let value: LauncherConfig =
        serde_json::from_slice(&fs::read(path).map_err(|_| "桌面启动配置无法读取。".to_string())?)
            .map_err(|_| "桌面启动配置已损坏。".to_string())?;
    if value.version != 1 || !value.data_dir.is_absolute() {
        return Err("桌面启动配置版本或路径无效。".to_string());
    }
    validate_directory(&value.data_dir, false).map(Some)
}

fn write_launcher(path: &Path, data_dir: &Path) -> Result<(), String> {
    if path.exists() {
        return Err("桌面数据目录已经配置；已有知识库请通过完整备份恢复迁移。".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "桌面启动配置路径无效。".to_string())?;
    if parent.exists() {
        let metadata =
            fs::symlink_metadata(parent).map_err(|_| "桌面启动配置目录无法访问。".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("桌面启动配置目录不安全。".to_string());
        }
    } else {
        fs::create_dir_all(parent).map_err(|_| "无法创建桌面启动配置目录。".to_string())?;
    }
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法保护桌面启动配置目录。".to_string())?;

    let temporary = parent.join(format!(".launcher-{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec(&LauncherConfig {
        version: 1,
        data_dir: data_dir.to_path_buf(),
    })
    .map_err(|_| "无法生成桌面启动配置。".to_string())?;
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法创建桌面启动配置。".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存桌面启动配置。".to_string())?;
        fs::hard_link(&temporary, path).map_err(|_| "无法发布桌面启动配置。".to_string())?;
        if fs::remove_file(&temporary).is_err() {
            let _ = fs::remove_file(path);
            return Err("无法完成桌面启动配置。".to_string());
        }
        if File::open(parent)
            .and_then(|directory| directory.sync_all())
            .is_err()
        {
            let _ = fs::remove_file(path);
            return Err("无法同步桌面启动配置。".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn resolve_data_directory(
    launcher: &Path,
    legacy_launcher: &Path,
    default: &Path,
    legacy_default: &Path,
) -> Result<PathBuf, String> {
    if let Some(configured) = read_launcher(launcher)? {
        return Ok(configured);
    }

    if let Some(configured) = read_launcher(legacy_launcher)? {
        ensure_complete_state(data_state(&configured)?)?;
        let current = data_state(default)?;
        ensure_complete_state(current)?;
        if current.data && !same_location(&configured, default) {
            return Err(
                "同时检测到旧版与正式知识库；已停止启动，请先用完整留档合并数据。".to_string(),
            );
        }
        validate_migration_target(&configured, default, launcher, legacy_launcher)?;
        write_launcher(launcher, &configured)?;
        return Ok(configured);
    }

    let current = data_state(default)?;
    let legacy = data_state(legacy_default)?;
    ensure_complete_state(current)?;
    ensure_complete_state(legacy)?;
    match (current.data, legacy.data) {
        (true, true) => {
            Err("同时检测到旧版与正式知识库；已停止启动，请先用完整留档合并数据。".to_string())
        }
        (false, true) => {
            let legacy_default = validate_directory(legacy_default, false)?;
            validate_migration_target(&legacy_default, default, launcher, legacy_launcher)?;
            write_launcher(launcher, &legacy_default)?;
            Ok(legacy_default)
        }
        _ => Ok(default.to_path_buf()),
    }
}

pub fn data_directory(app: &AppHandle, default: PathBuf) -> Result<PathBuf, String> {
    let legacy_default = default.with_file_name(LEGACY_IDENTIFIER);
    resolve_data_directory(
        &launcher_path(app)?,
        &legacy_launcher_path(app)?,
        &default,
        &legacy_default,
    )
}

#[tauri::command]
#[cfg(target_os = "macos")]
pub async fn choose_data_directory(app: AppHandle) -> Result<DataDirectoryChoice, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("选择织页知识库的空文件夹")
        .blocking_pick_folder()
    else {
        return Ok(DataDirectoryChoice { configured: false });
    };
    let FilePath::Path(path) = selected else {
        return Err("请选择本机文件夹。".to_string());
    };
    let data_dir = validate_directory(&path, true)?;
    let default = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位默认数据目录。".to_string())?;
    let current = data_directory(&app, default.clone())?;
    let launcher_root = launcher_path(&app)?
        .parent()
        .ok_or_else(|| "桌面启动配置路径无效。".to_string())?
        .to_path_buf();
    let mut protected = related_paths(&default);
    protected.extend(related_paths(&current));
    protected.push(launcher_root);
    let candidate = related_paths(&data_dir);
    if candidate
        .iter()
        .any(|left| protected.iter().any(|right| overlaps(left, right)))
        || companion_paths(&data_dir).iter().any(|path| path.exists())
    {
        return Err("所选文件夹不能位于当前数据、备份或启动配置目录内。".to_string());
    }
    write_launcher(&launcher_path(&app)?, &data_dir)?;
    Ok(DataDirectoryChoice { configured: true })
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub async fn choose_data_directory(_app: AppHandle) -> Result<DataDirectoryChoice, String> {
    Err("自定义桌面数据目录目前仅支持 macOS。".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("zhiye-launcher-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn launcher_config_round_trips_and_rejects_bad_or_nonempty_directories() {
        let root = temporary_root();
        let config = root.join("config/launcher.json");
        let selected = root.join("selected");
        fs::create_dir(&selected).unwrap();
        let canonical = validate_directory(&selected, true).unwrap();
        write_launcher(&config, &canonical).unwrap();
        assert_eq!(read_launcher(&config).unwrap(), Some(canonical));
        assert!(write_launcher(&config, &selected).is_err());
        assert!(!fs::read_dir(config.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".launcher-")));

        fs::write(selected.join("existing.txt"), "occupied").unwrap();
        assert!(validate_directory(&selected, true).is_err());
        assert!(overlaps(&selected.join("nested"), &selected));
        assert!(!overlaps(&root.join("other"), &selected));
        let candidate = root.join("archive");
        let old_data = root.join("archive-backups");
        assert!(related_paths(&candidate)
            .iter()
            .any(|left| related_paths(&old_data)
                .iter()
                .any(|right| overlaps(left, right))));
        fs::write(&config, br#"{"version":2,"data_dir":"relative"}"#).unwrap();
        assert!(read_launcher(&config).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn formal_identity_reuses_one_legacy_library_and_rejects_ambiguous_state() {
        let root = temporary_root();
        let launcher = root.join("io.github.sarainoq.zhiye-launcher/launcher.json");
        let legacy_launcher = root.join("dev.local.zhiye-launcher/launcher.json");
        let default = root.join("io.github.sarainoq.zhiye");
        let legacy_default = root.join("dev.local.zhiye");
        fs::create_dir(&legacy_default).unwrap();
        fs::write(legacy_default.join("zhiye.sqlite3"), "legacy").unwrap();

        let selected =
            resolve_data_directory(&launcher, &legacy_launcher, &default, &legacy_default).unwrap();
        assert_eq!(selected, fs::canonicalize(&legacy_default).unwrap());
        assert_eq!(read_launcher(&launcher).unwrap(), Some(selected.clone()));

        fs::create_dir(&default).unwrap();
        fs::write(default.join("zhiye.sqlite3"), "formal").unwrap();
        assert_eq!(
            resolve_data_directory(&launcher, &legacy_launcher, &default, &legacy_default,)
                .unwrap(),
            selected
        );

        let authoritative = root.join("authoritative-case");
        let authoritative_launcher = authoritative.join("formal-launcher/launcher.json");
        let authoritative_legacy_launcher = authoritative.join("legacy-launcher/launcher.json");
        let authoritative_default = authoritative.join("formal");
        let authoritative_legacy_default = authoritative.join("legacy");
        let authoritative_target = authoritative.join("chosen");
        fs::create_dir_all(&authoritative_target).unwrap();
        fs::write(authoritative_target.join("zhiye.sqlite3"), "chosen").unwrap();
        fs::create_dir(&authoritative_legacy_default).unwrap();
        fs::write(authoritative_legacy_default.join("zhiye.sqlite3"), "legacy").unwrap();
        write_launcher(&authoritative_launcher, &authoritative_target).unwrap();
        assert_eq!(
            resolve_data_directory(
                &authoritative_launcher,
                &authoritative_legacy_launcher,
                &authoritative_default,
                &authoritative_legacy_default,
            )
            .unwrap(),
            fs::canonicalize(&authoritative_target).unwrap()
        );

        let conflict = root.join("conflict");
        let conflict_launcher = conflict.join("formal-launcher/launcher.json");
        let conflict_legacy_launcher = conflict.join("legacy-launcher/launcher.json");
        let conflict_default = conflict.join("formal");
        let conflict_legacy_default = conflict.join("legacy");
        fs::create_dir_all(&conflict_default).unwrap();
        fs::create_dir(&conflict_legacy_default).unwrap();
        fs::write(conflict_default.join("zhiye.sqlite3"), "formal").unwrap();
        fs::write(conflict_legacy_default.join("zhiye.sqlite3"), "legacy").unwrap();
        assert!(resolve_data_directory(
            &conflict_launcher,
            &conflict_legacy_launcher,
            &conflict_default,
            &conflict_legacy_default,
        )
        .is_err());
        assert!(!conflict_launcher.exists());

        let custom = root.join("custom-case");
        let custom_launcher = custom.join("formal-launcher/launcher.json");
        let custom_legacy_launcher = custom.join("legacy-launcher/launcher.json");
        let custom_default = custom.join("formal");
        let custom_legacy_default = custom.join("legacy");
        let custom_data = custom.join("library");
        fs::create_dir_all(&custom_data).unwrap();
        fs::write(custom_data.join("zhiye.sqlite3"), "custom").unwrap();
        write_launcher(&custom_legacy_launcher, &custom_data).unwrap();
        assert_eq!(
            resolve_data_directory(
                &custom_launcher,
                &custom_legacy_launcher,
                &custom_default,
                &custom_legacy_default,
            )
            .unwrap(),
            fs::canonicalize(&custom_data).unwrap()
        );

        let unsafe_root = custom.join("unsafe-legacy");
        let unsafe_target = unsafe_root.join("nested-library");
        fs::create_dir_all(&unsafe_target).unwrap();
        fs::write(unsafe_target.join("zhiye.sqlite3"), "unsafe").unwrap();
        let unsafe_legacy_launcher = unsafe_root.join("launcher.json");
        fs::write(
            &unsafe_legacy_launcher,
            serde_json::to_vec(&LauncherConfig {
                version: 1,
                data_dir: unsafe_target,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(resolve_data_directory(
            &custom.join("unsafe-formal/launcher.json"),
            &unsafe_legacy_launcher,
            &custom.join("unsafe-formal"),
            &custom.join("unsafe-legacy-default"),
        )
        .is_err());

        let incomplete = root.join("incomplete");
        let incomplete_default = incomplete.join("formal");
        let incomplete_legacy_default = incomplete.join("legacy");
        fs::create_dir_all(incomplete.join("legacy-backups")).unwrap();
        fs::write(incomplete.join("legacy-backups/manifest"), "backup").unwrap();
        assert!(resolve_data_directory(
            &incomplete.join("formal-launcher/launcher.json"),
            &incomplete.join("legacy-launcher/launcher.json"),
            &incomplete_default,
            &incomplete_legacy_default,
        )
        .is_err());

        fs::remove_dir_all(root).unwrap();
    }
}
