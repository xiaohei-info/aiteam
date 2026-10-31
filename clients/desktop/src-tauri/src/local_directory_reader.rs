//! Descriptor-relative source reads. No path selected by a model is accepted here.
//! macOS only: every component is opened with O_NOFOLLOW, and F_GETPATH plus
//! device/inode checks detect renamed/replaced parents before delivery.
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::fs::{File, Metadata};
use std::io::Read;
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

pub fn identity(meta: &Metadata) -> String {
    format!("{}:{}", meta.dev(), meta.ino())
}

fn open_at(parent: &File, name: &std::ffi::OsStr, directory: bool) -> Result<File, String> {
    let name = CString::new(name.as_bytes()).map_err(|_| "invalid_path")?;
    let flags = libc::O_RDONLY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: borrowed parent descriptor and terminated component remain live.
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err("file_unavailable".into());
    }
    // SAFETY: openat returned a new owned descriptor.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn fd_path(file: &File) -> Result<PathBuf, String> {
    let mut bytes = [0_i8; libc::PATH_MAX as usize];
    // SAFETY: F_GETPATH writes at most PATH_MAX bytes into the live buffer.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, bytes.as_mut_ptr()) } < 0 {
        return Err("source_changed".into());
    }
    // SAFETY: successful F_GETPATH returns a NUL-terminated path.
    let path = unsafe { CStr::from_ptr(bytes.as_ptr()) };
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(path.to_bytes())))
}

pub struct SourceRoot {
    path: PathBuf,
    file: File,
    identity: String,
}

impl SourceRoot {
    pub fn open(path: &Path, expected_identity: Option<&str>) -> Result<Self, String> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return Err("invalid_path".into());
        }
        let mut file = File::open("/").map_err(|_| "file_unavailable")?;
        for component in path.components() {
            if let Component::Normal(name) = component {
                file = open_at(&file, name, true)?;
            }
        }
        let meta = file.metadata().map_err(|_| "file_unavailable")?;
        let root_identity = identity(&meta);
        if expected_identity.is_some_and(|value| value != root_identity) {
            return Err("source_changed".into());
        }
        let root = Self {
            path: path.to_path_buf(),
            file,
            identity: root_identity,
        };
        root.check()?;
        Ok(root)
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    pub fn check(&self) -> Result<(), String> {
        if fd_path(&self.file)? != self.path {
            return Err("source_changed".into());
        }
        let current = std::fs::symlink_metadata(&self.path).map_err(|_| "source_changed")?;
        if !current.is_dir() || identity(&current) != self.identity {
            return Err("source_changed".into());
        }
        Ok(())
    }

    /// Enumerate only an opened directory, bounded independently of file count.
    pub fn list(
        &self,
        relative: &Path,
        limit: usize,
    ) -> Result<(Vec<(String, bool)>, bool), String> {
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("invalid_path".into());
        }
        self.check()?;
        let mut directory = self.file.try_clone().map_err(|_| "file_unavailable")?;
        for component in relative.components() {
            if let Component::Normal(name) = component {
                directory = open_at(&directory, name, true)?;
            }
        }
        let expected = self.path.join(relative);
        if fd_path(&directory)? != expected {
            return Err("source_changed".into());
        }
        let fd = directory
            .try_clone()
            .map_err(|_| "file_unavailable")?
            .into_raw_fd();
        // SAFETY: fdopendir takes ownership of the newly duplicated descriptor.
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            // SAFETY: failed fdopendir leaves the descriptor owned by this call.
            unsafe {
                libc::close(fd);
            }
            return Err("file_unavailable".into());
        }
        let mut entries = Vec::new();
        let mut partial = false;
        for index in 0..=limit {
            // SAFETY: stream remains live until closed below; copy each entry immediately.
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            if index == limit {
                partial = true;
                break;
            }
            // SAFETY: readdir returned a live entry with a terminated d_name.
            let (name, kind) = unsafe {
                (
                    CStr::from_ptr((*entry).d_name.as_ptr())
                        .to_string_lossy()
                        .into_owned(),
                    (*entry).d_type,
                )
            };
            if name.starts_with('.')
                || name.starts_with('~')
                || name.ends_with('~')
                || name.ends_with(".tmp")
            {
                continue;
            }
            if kind == libc::DT_REG || kind == libc::DT_DIR {
                entries.push((name, kind == libc::DT_DIR));
            }
        }
        // SAFETY: stream is closed exactly once and owns its descriptor.
        unsafe {
            libc::closedir(stream);
        }
        self.check()?;
        if fd_path(&directory)? != expected {
            return Err("source_changed".into());
        }
        entries.sort();
        Ok((entries, partial))
    }

    pub fn read_text(&self, relative: &Path) -> Result<(String, String), String> {
        let extension = relative
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["txt", "md", "markdown", "csv", "json", "log"].contains(&extension.as_str()) {
            return Err("unsupported_format".into());
        }
        let components: Vec<_> = relative.components().collect();
        if components.is_empty()
            || components
                .iter()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err("invalid_path".into());
        }
        self.check()?;
        let mut parent = self.file.try_clone().map_err(|_| "file_unavailable")?;
        let mut parents = Vec::new();
        let mut expected = self.path.clone();
        for component in &components[..components.len() - 1] {
            let Component::Normal(name) = component else {
                return Err("invalid_path".into());
            };
            parent = open_at(&parent, name, true)?;
            expected.push(name);
            parents.push((
                parent.try_clone().map_err(|_| "file_unavailable")?,
                expected.clone(),
            ));
        }
        let Component::Normal(name) = components[components.len() - 1] else {
            return Err("invalid_path".into());
        };
        let file = open_at(&parent, name, false)?;
        let before = file.metadata().map_err(|_| "file_unavailable")?;
        if !before.is_file() || before.nlink() != 1 {
            return Err("unsupported_file".into());
        }
        if before.len() > MAX_FILE_BYTES {
            return Err("budget_exhausted".into());
        }
        expected.push(name);
        if fd_path(&file)? != expected {
            return Err("source_changed".into());
        }
        let mut bytes = Vec::new();
        (&file)
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "file_unavailable")?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("budget_exhausted".into());
        }
        let after = file.metadata().map_err(|_| "source_changed")?;
        if version(&before) != version(&after)
            || bytes.len() as u64 != after.len()
            || fd_path(&file)? != expected
        {
            return Err("source_changed".into());
        }
        self.check()?;
        for (directory, path) in parents {
            if fd_path(&directory)? != path {
                return Err("source_changed".into());
            }
            let current = std::fs::symlink_metadata(&path).map_err(|_| "source_changed")?;
            if !current.is_dir()
                || identity(&current)
                    != identity(&directory.metadata().map_err(|_| "source_changed")?)
            {
                return Err("source_changed".into());
            }
        }
        let mut hash = Sha256::new();
        hash.update(format!("{:?}", version(&after)));
        hash.update(&bytes);
        let content_version = hex::encode(hash.finalize());
        let text = String::from_utf8(bytes).map_err(|_| "parse_failed")?;
        if text.contains('\0') {
            return Err("parse_failed".into());
        }
        Ok((text, content_version))
    }
}

fn version(meta: &Metadata) -> (u64, u64, u64, i64, i64, i64, i64) {
    (
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("local-dir-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(path.join("docs/sub")).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn plain_text_versions_and_link_boundaries() {
        let base = Fixture::new();
        let docs = base.0.join("docs");
        std::fs::write(docs.join("sub/发布.md"), "发布代号：青鸟🚀").unwrap();
        let root = SourceRoot::open(&docs, None).unwrap();
        let (text, first) = root.read_text(Path::new("sub/发布.md")).unwrap();
        assert_eq!(text, "发布代号：青鸟🚀");
        std::fs::write(docs.join("sub/发布.md"), "下一版").unwrap();
        assert_ne!(root.read_text(Path::new("sub/发布.md")).unwrap().1, first);
        assert!(root.read_text(Path::new("../secret.txt")).is_err());
        assert!(root.read_text(Path::new("/etc/passwd")).is_err());
        symlink(docs.join("sub/发布.md"), docs.join("link.md")).unwrap();
        assert!(root.read_text(Path::new("link.md")).is_err());
        symlink(docs.join("sub"), docs.join("alias")).unwrap();
        assert!(root.read_text(Path::new("alias/发布.md")).is_err());
        std::fs::hard_link(docs.join("sub/发布.md"), docs.join("hard.md")).unwrap();
        assert!(root.read_text(Path::new("hard.md")).is_err());
    }
    #[test]
    fn root_replacement_encoding_special_files_and_budget() {
        let base = Fixture::new();
        let docs = base.0.join("docs");
        let root = SourceRoot::open(&docs, None).unwrap();
        std::fs::write(docs.join("invalid.txt"), [0xff, 0xfe]).unwrap();
        assert_eq!(
            root.read_text(Path::new("invalid.txt")).unwrap_err(),
            "parse_failed"
        );
        let huge = File::create(docs.join("huge.txt")).unwrap();
        huge.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert_eq!(
            root.read_text(Path::new("huge.txt")).unwrap_err(),
            "budget_exhausted"
        );
        let fifo = CString::new(docs.join("pipe.txt").as_os_str().as_bytes()).unwrap();
        // SAFETY: terminated path points inside our disposable fixture.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(
            root.read_text(Path::new("pipe.txt")).unwrap_err(),
            "unsupported_file"
        );
        let old_identity = root.identity().to_string();
        std::fs::rename(&docs, base.0.join("moved")).unwrap();
        std::fs::create_dir(&docs).unwrap();
        assert!(root.check().is_err());
        assert!(SourceRoot::open(&docs, Some(&old_identity)).is_err());
    }
}
