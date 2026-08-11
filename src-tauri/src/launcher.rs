use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(any(target_os = "macos", test))]
use std::fs::{File, OpenOptions};
#[cfg(any(target_os = "macos", test))]
use std::io::Write;
#[cfg(any(target_os = "macos", test))]
use uuid::Uuid;

#[cfg(target_os = "macos")]
use tauri_plugin_dialog::{DialogExt, FilePath};

#[cfg(all(unix, any(target_os = "macos", test)))]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LauncherConfig {
    version: u8,
    data_dir: PathBuf,
}

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

#[cfg(any(target_os = "macos", test))]
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

#[cfg(any(target_os = "macos", test))]
fn related_paths(data_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![data_dir.to_path_buf()];
    paths.extend(companion_paths(data_dir));
    paths
}

#[cfg(any(target_os = "macos", test))]
fn overlaps(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
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

#[cfg(any(target_os = "macos", test))]
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
        fs::rename(&temporary, path).map_err(|_| "无法发布桌面启动配置。".to_string())?;
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

pub fn data_directory(app: &AppHandle, default: PathBuf) -> Result<PathBuf, String> {
    read_launcher(&launcher_path(app)?).map(|value| value.unwrap_or(default))
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
}
