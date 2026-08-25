use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
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

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PendingMigration {
    version: u8,
    source_dir: PathBuf,
    target_dir: PathBuf,
    phase: MigrationPhase,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LockReservation {
    pid: u32,
    token: String,
}

struct SourceLockReservation {
    path: PathBuf,
    token: String,
}

impl SourceLockReservation {
    fn release(&self) -> Result<(), String> {
        let current = fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<LockReservation>(&bytes).ok());
        if current.as_ref().map(|value| value.token.as_str()) != Some(self.token.as_str()) {
            return Ok(());
        }
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法释放源知识库迁移锁。".to_string()),
        }
    }
}

impl Drop for SourceLockReservation {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MigrationPhase {
    Copying,
    Ready,
}

const LEGACY_IDENTIFIER: &str = "dev.local.zhiye";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirectoryChoice {
    pub configured: bool,
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

fn migration_path(launcher: &Path) -> PathBuf {
    launcher.with_file_name(".migration.json")
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

fn storage_paths(data_dir: &Path) -> Vec<PathBuf> {
    let companions = companion_paths(data_dir);
    if companions.len() < 2 {
        return vec![data_dir.to_path_buf()];
    }
    vec![
        data_dir.to_path_buf(),
        companions[0].clone(),
        companions[1].clone(),
    ]
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

fn process_exists(pid: u32) -> bool {
    #[cfg(unix)]
    {
        return Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(true);
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn clear_or_reject_source_lock(data_dir: &Path) -> Result<(), String> {
    let lock = companion_paths(data_dir)
        .get(2)
        .ok_or_else(|| "数据目录路径无效。".to_string())?;
    let metadata = match fs::symlink_metadata(lock) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("无法确认源知识库是否仍被占用。".to_string()),
    };
    if let Some(metadata) = metadata {
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4 * 1024 {
            return Err("源知识库迁移锁不安全或已损坏。".to_string());
        }
        let lock_value = serde_json::from_slice::<LockReservation>(&fs::read(lock).map_err(|_| "无法读取源知识库迁移锁。".to_string())?)
            .map_err(|_| "无法解析源知识库迁移锁。".to_string())?;
        if process_exists(lock_value.pid) {
            return Err("源知识库仍被其他进程占用，请关闭其他织页或本地 Web 服务后重试。".to_string());
        }
        fs::remove_file(lock).map_err(|_| "无法清理已退出进程的源知识库迁移锁。".to_string())?;
    }
    Ok(())
}

fn reserve_source_lock(data_dir: &Path) -> Result<SourceLockReservation, String> {
    clear_or_reject_source_lock(data_dir)?;
    let path = companion_paths(data_dir)
        .get(2)
        .ok_or_else(|| "数据目录路径无效。".to_string())?
        .to_path_buf();
    let token = Uuid::new_v4().to_string();
    let bytes = serde_json::to_vec(&LockReservation {
        pid: std::process::id(),
        token: token.clone(),
    })
    .map_err(|_| "无法生成源知识库迁移锁。".to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&path)
        .map_err(|_| "源知识库仍被其他进程占用，请关闭其他织页或本地 Web 服务后重试。".to_string())?;
    if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() {
        let _ = fs::remove_file(&path);
        return Err("无法保存源知识库迁移锁。".to_string());
    }
    Ok(SourceLockReservation { path, token })
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

fn validate_change_target(
    target: &Path,
    current: &Path,
    default: &Path,
    launcher: &Path,
    legacy_launcher: &Path,
) -> Result<(), String> {
    if same_location(target, current) || same_location(target, default) {
        return Err("请选择不同于当前数据目录的文件夹。".to_string());
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
    let mut protected = related_paths(default);
    protected.extend(related_paths(current));
    if candidate
        .iter()
        .any(|left| protected.iter().any(|right| overlaps(left, right)))
        || candidate
            .iter()
            .any(|path| overlaps(path, &launcher_root) || overlaps(path, &legacy_launcher_root))
    {
        return Err("所选文件夹不能位于当前数据、备份或启动配置目录内。".to_string());
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

fn write_json_file<T: Serialize>(path: &Path, value: &T, replace: bool) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err("桌面启动配置路径不安全。".to_string())
        }
        Ok(_) if !replace => {
            return Err("桌面数据目录已经配置；已有知识库请通过完整备份恢复迁移。".to_string())
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err("桌面启动配置路径无法访问。".to_string())
        }
        _ => {}
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
    let bytes = serde_json::to_vec(value).map_err(|_| "无法生成桌面启动配置。".to_string())?;
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
        if replace {
            fs::rename(&temporary, path).map_err(|_| "无法发布桌面启动配置。".to_string())?;
        } else {
            fs::hard_link(&temporary, path).map_err(|_| "无法发布桌面启动配置。".to_string())?;
            if fs::remove_file(&temporary).is_err() {
                let _ = fs::remove_file(path);
                return Err("无法完成桌面启动配置。".to_string());
            }
        }
        if File::open(parent)
            .and_then(|directory| directory.sync_all())
            .is_err()
        {
            if !replace {
                let _ = fs::remove_file(path);
            }
            return Err("无法同步桌面启动配置。".to_string());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_launcher(path: &Path, data_dir: &Path) -> Result<(), String> {
    write_json_file(
        path,
        &LauncherConfig {
            version: 1,
            data_dir: data_dir.to_path_buf(),
        },
        false,
    )
}

fn replace_launcher(path: &Path, data_dir: &Path) -> Result<(), String> {
    write_json_file(
        path,
        &LauncherConfig {
            version: 1,
            data_dir: data_dir.to_path_buf(),
        },
        true,
    )
}

fn read_pending_migration(path: &Path) -> Result<Option<PendingMigration>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("数据目录迁移状态无法读取。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 16 * 1024 {
        return Err("数据目录迁移状态不安全或已损坏。".to_string());
    }
    let value = serde_json::from_slice(&fs::read(path).map_err(|_| "数据目录迁移状态无法读取。".to_string())?)
        .map_err(|_| "数据目录迁移状态已损坏。".to_string())?;
    Ok(Some(value))
}

fn write_pending_migration(path: &Path, migration: &PendingMigration) -> Result<(), String> {
    write_json_file(path, migration, true)
}

fn clear_pending_migration(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => {
            if let Some(parent) = path.parent() {
                File::open(parent)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|_| "无法同步数据目录迁移状态。".to_string())?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法清理数据目录迁移状态。".to_string()),
    }
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let mut left_file = File::open(left).map_err(|_| "无法校验迁移后的数据文件。".to_string())?;
    let mut right_file = File::open(right).map_err(|_| "无法校验迁移后的数据文件。".to_string())?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_read = left_file
            .read(&mut left_buffer)
            .map_err(|_| "无法读取迁移源文件。".to_string())?;
        let right_read = right_file
            .read(&mut right_buffer)
            .map_err(|_| "无法读取迁移目标文件。".to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|_| "无法读取迁移源目录。".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("知识库中包含不安全的迁移路径。".to_string());
    }
    fs::create_dir_all(target).map_err(|_| "无法创建迁移目标目录。".to_string())?;
    for entry in fs::read_dir(source).map_err(|_| "无法读取迁移源目录。".to_string())? {
        let entry = entry.map_err(|_| "无法读取迁移源目录。".to_string())?;
        let source_entry = entry.path();
        let target_entry = target.join(entry.file_name());
        let entry_metadata = fs::symlink_metadata(&source_entry)
            .map_err(|_| "无法读取知识库中的迁移条目。".to_string())?;
        if entry_metadata.file_type().is_symlink() {
            return Err("知识库中包含不安全的符号链接，已停止迁移。".to_string());
        }
        if entry_metadata.is_dir() {
            copy_tree(&source_entry, &target_entry)?;
        } else if entry_metadata.is_file() {
            fs::copy(&source_entry, &target_entry)
                .map_err(|_| "无法复制知识库文件。".to_string())?;
            File::open(&target_entry)
                .and_then(|file| file.sync_all())
                .map_err(|_| "无法持久化迁移文件。".to_string())?;
            if !files_equal(&source_entry, &target_entry)? {
                return Err("迁移后的知识库文件校验不一致。".to_string());
            }
            #[cfg(unix)]
            fs::set_permissions(&target_entry, entry_metadata.permissions())
                .map_err(|_| "无法保存迁移文件权限。".to_string())?;
        } else {
            return Err("知识库中包含不支持的迁移条目。".to_string());
        }
    }
    #[cfg(unix)]
    fs::set_permissions(target, metadata.permissions())
        .map_err(|_| "无法保存迁移目录权限。".to_string())?;
    Ok(())
}

fn copy_path(source: &Path, target: &Path) -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(source) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法读取迁移源路径。".to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("知识库中包含不安全的符号链接，已停止迁移。".to_string());
    }
    if metadata.is_dir() {
        copy_tree(source, target)?;
    } else if metadata.is_file() {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "无法创建迁移目标目录。".to_string())?;
        }
        fs::copy(source, target).map_err(|_| "无法复制知识库文件。".to_string())?;
        File::open(target)
            .and_then(|file| file.sync_all())
            .map_err(|_| "无法持久化迁移文件。".to_string())?;
        if !files_equal(source, target)? {
            return Err("迁移后的知识库文件校验不一致。".to_string());
        }
        #[cfg(unix)]
        fs::set_permissions(target, metadata.permissions())
            .map_err(|_| "无法保存迁移文件权限。".to_string())?;
    } else {
        return Err("知识库中包含不支持的迁移条目。".to_string());
    }
    Ok(true)
}

fn remove_path(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法读取待清理的数据目录。".to_string()),
    };
    if metadata.file_type().is_symlink() {
        return Err("待清理的数据路径包含符号链接。".to_string());
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|_| "无法清理旧知识库目录。".to_string())?;
    } else if metadata.is_file() {
        fs::remove_file(path).map_err(|_| "无法清理旧知识库文件。".to_string())?;
    } else {
        return Err("待清理的数据路径类型不受支持。".to_string());
    }
    Ok(())
}

fn migration_staging_path(path: &Path, id: &str) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .ok_or_else(|| "迁移路径无效。".to_string())?
        .to_string_lossy();
    Ok(path.with_file_name(format!(".{name}-zhiye-migration-{id}")))
}

fn pending_target_directory(path: &Path) -> Result<PathBuf, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("迁移目标路径不安全。".to_string());
            }
            fs::canonicalize(path).map_err(|_| "迁移目标目录无法解析。".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| "迁移目标路径无效。".to_string())?;
            let metadata = fs::symlink_metadata(parent)
                .map_err(|_| "迁移目标目录的父目录无法访问。".to_string())?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("迁移目标目录的父路径不安全。".to_string());
            }
            Ok(path.to_path_buf())
        }
        Err(_) => Err("迁移目标目录无法访问。".to_string()),
    }
}

fn tree_is_subset(source: &Path, target: &Path) -> Result<bool, String> {
    let source_metadata = fs::symlink_metadata(source).map_err(|_| "迁移源路径无法访问。".to_string())?;
    let target_metadata = fs::symlink_metadata(target).map_err(|_| "迁移目标路径无法访问。".to_string())?;
    if source_metadata.file_type().is_symlink() || target_metadata.file_type().is_symlink() {
        return Ok(false);
    }
    if source_metadata.is_dir() && target_metadata.is_dir() {
        for entry in fs::read_dir(target).map_err(|_| "无法读取迁移目标目录。".to_string())? {
            let entry = entry.map_err(|_| "无法读取迁移目标目录。".to_string())?;
            if !tree_is_subset(&source.join(entry.file_name()), &entry.path())? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    if source_metadata.is_file() && target_metadata.is_file() {
        return files_equal(source, target);
    }
    Ok(false)
}

fn cleanup_migration_staging(target: &Path) -> Result<(), String> {
    let parent = target.parent().ok_or_else(|| "迁移目标路径无效。".to_string())?;
    let name = target
        .file_name()
        .ok_or_else(|| "迁移目标路径无效。".to_string())?
        .to_string_lossy();
    let prefix = format!(".{name}-zhiye-migration-");
    let entries = match fs::read_dir(parent) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法读取迁移目标父目录。".to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "无法读取迁移目标父目录。".to_string())?;
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            remove_path(&entry.path())?;
        }
    }
    Ok(())
}

fn reset_partial_target(source: &Path, target: &Path) -> Result<(), String> {
    for (source_path, target_path) in storage_paths(source).iter().zip(storage_paths(target).iter()) {
        let target_exists = fs::symlink_metadata(target_path).is_ok();
        if !target_exists {
            continue;
        }
        let source_exists = fs::symlink_metadata(source_path).is_ok();
        if !source_exists || !tree_is_subset(source_path, target_path)? {
            return Err("迁移目标包含无法确认来源的数据，已停止启动以保护数据。".to_string());
        }
        remove_path(target_path)?;
    }
    for target_path in storage_paths(target) {
        cleanup_migration_staging(&target_path)?;
    }
    if fs::symlink_metadata(target).is_err() {
        fs::create_dir_all(target).map_err(|_| "无法重建迁移目标目录。".to_string())?;
    }
    Ok(())
}

fn copy_and_promote_bundle(source: &Path, target: &Path) -> Result<(), String> {
    let source_paths = storage_paths(source);
    let target_paths = storage_paths(target);
    let id = Uuid::new_v4().to_string();
    let mut staged = Vec::new();
    for (source_path, target_path) in source_paths.iter().zip(target_paths.iter()) {
        let staging_path = migration_staging_path(target_path, &id)?;
        match copy_path(source_path, &staging_path) {
            Ok(false) => continue,
            Ok(true) => staged.push((staging_path, target_path.to_path_buf())),
            Err(error) => {
                let _ = remove_path(&staging_path);
                for (path, _) in &staged {
                    let _ = remove_path(path);
                }
                return Err(error);
            }
        }
    }
    let mut promoted = Vec::new();
    for (staging, target_path) in &staged {
        let target_metadata = fs::symlink_metadata(target_path);
        if let Ok(metadata) = target_metadata {
            if metadata.file_type().is_symlink()
                || !metadata.is_dir()
                || fs::read_dir(target_path)
                    .map_err(|_| "无法读取迁移目标目录。".to_string())?
                    .next()
                    .is_some()
            {
                for (path, _) in &staged {
                    let _ = remove_path(path);
                }
                return Err("迁移目标目录必须为空。".to_string());
            }
            fs::remove_dir(target_path).map_err(|_| "无法准备迁移目标目录。".to_string())?;
        }
        if let Err(error) = fs::rename(staging, target_path) {
            for path in &promoted {
                let _ = remove_path(path);
            }
            let _ = fs::create_dir(target);
            for (path, _) in &staged {
                let _ = remove_path(path);
            }
            return Err(format!("无法发布迁移后的知识库：{error}"));
        }
        promoted.push(target_path.to_path_buf());
    }
    Ok(())
}

fn cleanup_source_bundle(source: &Path) -> Result<(), String> {
    for path in storage_paths(source) {
        remove_path(&path)?;
    }
    Ok(())
}

fn apply_pending_migration(
    launcher: &Path,
    legacy_launcher: &Path,
    default: &Path,
) -> Result<(), String> {
    let marker = migration_path(launcher);
    let Some(mut migration) = read_pending_migration(&marker)? else {
        return Ok(());
    };
    if migration.version != 1
        || !migration.source_dir.is_absolute()
        || !migration.target_dir.is_absolute()
    {
        return Err("数据目录迁移状态版本或路径无效。".to_string());
    }
    let current = if let Some(configured) = read_launcher(launcher)? {
        configured
    } else if let Some(configured) = read_launcher(legacy_launcher)? {
        configured
    } else {
        default.to_path_buf()
    };
    let mut source_lock = None;
    if migration.phase == MigrationPhase::Copying {
        if !same_location(&current, &migration.source_dir) {
            return Err("数据目录迁移源与当前启动配置不一致。".to_string());
        }
        let source = validate_directory(&migration.source_dir, false)?;
        let target = pending_target_directory(&migration.target_dir)?;
        validate_change_target(&target, &source, default, launcher, legacy_launcher)?;
        source_lock = Some(reserve_source_lock(&source)?);
        reset_partial_target(&source, &target)?;
        let target = validate_directory(&target, true)?;
        ensure_complete_state(data_state(&source)?)?;
        copy_and_promote_bundle(&source, &target)?;
        migration.phase = MigrationPhase::Ready;
        if let Err(error) = write_pending_migration(&marker, &migration) {
            let _ = reset_partial_target(&source, &target);
            return Err(error);
        }
    }

    let source = match fs::symlink_metadata(&migration.source_dir) {
        Ok(_) => validate_directory(&migration.source_dir, false)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => migration.source_dir.clone(),
        Err(_) => return Err("迁移源目录无法访问。".to_string()),
    };
    let target = validate_directory(&migration.target_dir, false)?;
    if !directory_has_entries(&target)? {
        return Err("迁移目标目录不完整，已停止启动以保护数据。".to_string());
    }
    ensure_complete_state(data_state(&target)?)?;
    let source_lock_path = companion_paths(&source)
        .get(2)
        .map(|path| fs::symlink_metadata(path).is_ok())
        .unwrap_or(false);
    if (source.exists() || source_lock_path) && source_lock.is_none() {
        source_lock = Some(reserve_source_lock(&source)?);
    }
    if !same_location(&current, &target) {
        if !same_location(&current, &source) {
            return Err("数据目录迁移状态与启动配置不一致。".to_string());
        }
        replace_launcher(launcher, &target)?;
    }
    cleanup_source_bundle(&source)?;
    clear_pending_migration(&marker)?;
    if let Some(reservation) = source_lock {
        reservation.release()?;
    }
    Ok(())
}

fn resolve_data_directory(
    launcher: &Path,
    legacy_launcher: &Path,
    default: &Path,
    legacy_default: &Path,
) -> Result<PathBuf, String> {
    apply_pending_migration(launcher, legacy_launcher, default)?;
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
    let Some(data_dir) = pick_empty_directory(&app)? else {
        return Ok(DataDirectoryChoice { configured: false });
    };
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

#[cfg(target_os = "macos")]
fn pick_empty_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let Some(selected) = app
        .dialog()
        .file()
        .set_title("选择织页知识库的空文件夹")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let FilePath::Path(path) = selected else {
        return Err("请选择本机文件夹。".to_string());
    };
    validate_directory(&path, true).map(Some)
}

#[cfg(target_os = "macos")]
pub fn stage_data_directory_change(app: &AppHandle) -> Result<DataDirectoryChoice, String> {
    let Some(data_dir) = pick_empty_directory(app)? else {
        return Ok(DataDirectoryChoice { configured: false });
    };
    let default = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位默认数据目录。".to_string())?;
    let launcher = launcher_path(app)?;
    let legacy_launcher = legacy_launcher_path(app)?;
    let marker = migration_path(&launcher);
    if marker.exists() {
        return Err("已有数据目录迁移正在等待安全重启。".to_string());
    }
    let current = if let Some(configured) = read_launcher(&launcher)? {
        configured
    } else if let Some(configured) = read_launcher(&legacy_launcher)? {
        configured
    } else {
        default.clone()
    };
    validate_change_target(&data_dir, &current, &default, &launcher, &legacy_launcher)?;
    if companion_paths(&data_dir)
        .iter()
        .any(|path| fs::symlink_metadata(path).is_ok())
    {
        return Err("所选文件夹不能位于当前数据、备份或启动配置目录内。".to_string());
    }
    ensure_complete_state(data_state(&current)?)?;
    write_pending_migration(
        &marker,
        &PendingMigration {
            version: 1,
            source_dir: current,
            target_dir: data_dir,
            phase: MigrationPhase::Copying,
        },
    )?;
    Ok(DataDirectoryChoice { configured: true })
}

#[cfg(target_os = "macos")]
pub fn cancel_staged_data_directory_change(app: &AppHandle) -> Result<(), String> {
    clear_pending_migration(&migration_path(&launcher_path(app)?))
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub async fn choose_data_directory(_app: AppHandle) -> Result<DataDirectoryChoice, String> {
    Err("自定义桌面数据目录目前仅支持 macOS。".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn stage_data_directory_change(_app: &AppHandle) -> Result<DataDirectoryChoice, String> {
    Err("自定义桌面数据目录目前仅支持 macOS。".to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn cancel_staged_data_directory_change(_app: &AppHandle) -> Result<(), String> {
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

    #[test]
    fn pending_migration_copies_the_complete_bundle_before_switching_launcher() {
        let root = temporary_root();
        let launcher = root.join("formal-launcher/launcher.json");
        let legacy_launcher = root.join("legacy-launcher/launcher.json");
        let default = root.join("formal");
        let legacy_default = root.join("legacy");
        let source = root.join("library");
        let target = root.join("moved");
        fs::create_dir_all(source.join("snapshots/nested")).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("zhiye.sqlite3"), "database").unwrap();
        fs::write(source.join("snapshots/nested/page.html"), "snapshot").unwrap();
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("assets/image.png"), "asset").unwrap();
        fs::create_dir_all(root.join("library-backups")).unwrap();
        fs::write(root.join("library-backups/manifest"), "backup").unwrap();
        fs::create_dir_all(root.join("library-diagnostics")).unwrap();
        fs::write(root.join("library-diagnostics/log"), "diagnostic").unwrap();
        write_launcher(&launcher, &fs::canonicalize(&source).unwrap()).unwrap();
        write_pending_migration(
            &migration_path(&launcher),
            &PendingMigration {
                version: 1,
                source_dir: fs::canonicalize(&source).unwrap(),
                target_dir: fs::canonicalize(&target).unwrap(),
                phase: MigrationPhase::Copying,
            },
        )
        .unwrap();

        let resolved = resolve_data_directory(&launcher, &legacy_launcher, &default, &legacy_default).unwrap();
        assert_eq!(resolved, fs::canonicalize(&target).unwrap());
        assert_eq!(fs::read_to_string(target.join("zhiye.sqlite3")).unwrap(), "database");
        assert_eq!(fs::read_to_string(target.join("snapshots/nested/page.html")).unwrap(), "snapshot");
        assert_eq!(fs::read_to_string(root.join("moved-backups/manifest")).unwrap(), "backup");
        assert_eq!(fs::read_to_string(root.join("moved-diagnostics/log")).unwrap(), "diagnostic");
        assert!(!source.exists());
        assert!(!root.join("library-backups").exists());
        assert!(!migration_path(&launcher).exists());
        assert_eq!(read_launcher(&launcher).unwrap(), Some(fs::canonicalize(&target).unwrap()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_migration_retries_a_partial_target_and_cleans_staging() {
        let root = temporary_root();
        let launcher = root.join("formal-launcher/launcher.json");
        let legacy_launcher = root.join("legacy-launcher/launcher.json");
        let default = root.join("formal");
        let legacy_default = root.join("legacy");
        let source = root.join("library");
        let target = root.join("moved");
        fs::create_dir_all(source.join("snapshots")).unwrap();
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("zhiye.sqlite3"), "database").unwrap();
        fs::write(source.join("snapshots/page.html"), "snapshot").unwrap();
        fs::write(source.join("assets/image.png"), "asset").unwrap();
        fs::create_dir_all(root.join("library-backups")).unwrap();
        fs::write(root.join("library-backups/manifest"), "backup").unwrap();
        fs::write(target.join("zhiye.sqlite3"), "database").unwrap();
        fs::create_dir_all(root.join("moved-backups")).unwrap();
        fs::write(root.join("moved-backups/manifest"), "backup").unwrap();
        let stale = migration_staging_path(&target, "stale").unwrap();
        fs::create_dir_all(stale).unwrap();
        fs::write(stale.join("partial"), "partial").unwrap();
        write_launcher(&launcher, &fs::canonicalize(&source).unwrap()).unwrap();
        write_pending_migration(
            &migration_path(&launcher),
            &PendingMigration {
                version: 1,
                source_dir: fs::canonicalize(&source).unwrap(),
                target_dir: fs::canonicalize(&target).unwrap(),
                phase: MigrationPhase::Copying,
            },
        )
        .unwrap();

        let resolved = resolve_data_directory(&launcher, &legacy_launcher, &default, &legacy_default).unwrap();
        assert_eq!(resolved, fs::canonicalize(&target).unwrap());
        assert_eq!(fs::read_to_string(target.join("snapshots/page.html")).unwrap(), "snapshot");
        assert!(!stale.exists());
        assert!(!source.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_migration_keeps_source_and_target_when_a_lock_remains() {
        let root = temporary_root();
        let launcher = root.join("formal-launcher/launcher.json");
        let legacy_launcher = root.join("legacy-launcher/launcher.json");
        let default = root.join("formal");
        let legacy_default = root.join("legacy");
        let source = root.join("library");
        let target = root.join("moved");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("zhiye.sqlite3"), "database").unwrap();
        fs::write(companion_paths(&source)[2].clone(), "locked").unwrap();
        write_launcher(&launcher, &fs::canonicalize(&source).unwrap()).unwrap();
        write_pending_migration(
            &migration_path(&launcher),
            &PendingMigration {
                version: 1,
                source_dir: fs::canonicalize(&source).unwrap(),
                target_dir: fs::canonicalize(&target).unwrap(),
                phase: MigrationPhase::Copying,
            },
        )
        .unwrap();

        assert!(resolve_data_directory(&launcher, &legacy_launcher, &default, &legacy_default).is_err());
        assert_eq!(fs::read_to_string(source.join("zhiye.sqlite3")).unwrap(), "database");
        assert!(target.read_dir().unwrap().next().is_none());
        assert!(migration_path(&launcher).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn source_lock_reservation_blocks_a_second_owner_until_release() {
        let root = temporary_root();
        let source = root.join("library");
        fs::create_dir(&source).unwrap();
        let reservation = reserve_source_lock(&source).unwrap();
        assert!(reserve_source_lock(&source).is_err());
        reservation.release().unwrap();
        let second = reserve_source_lock(&source).unwrap();
        second.release().unwrap();
        fs::write(
            companion_paths(&source)[2].clone(),
            serde_json::to_vec(&LockReservation { pid: u32::MAX, token: "stale".to_string() }).unwrap(),
        )
        .unwrap();
        let recovered = reserve_source_lock(&source).unwrap();
        recovered.release().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn migration_rejects_symlinked_entries_without_touching_source() {
        use std::os::unix::fs::symlink;

        let root = temporary_root();
        let source = root.join("source");
        let target = root.join("target");
        let outside = root.join("outside");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret"), "secret").unwrap();
        symlink(&outside, source.join("snapshots")).unwrap();
        assert!(copy_and_promote_bundle(&source, &target).is_err());
        assert!(source.join("snapshots").exists());
        assert!(target.read_dir().unwrap().next().is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
