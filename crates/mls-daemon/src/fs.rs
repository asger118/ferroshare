//! Sandboxed, read-only access to the host's workspace for guests.
//!
//! Every guest-supplied path goes through [`Workspace::resolve`], which
//! rejects anything that could escape the shared folder (`..`, absolute
//! paths, drive letters, symlinks pointing outside) and the `.git` directory.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use mls_proto::{DirEntry, FileKind};

/// Files larger than this are not shared as live text documents.
pub const MAX_TEXT_FILE: u64 = 10 * 1024 * 1024;
/// Largest file a guest can fetch as raw bytes.
pub const MAX_BINARY_FILE: u64 = 50 * 1024 * 1024;

pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn new(root: &Path) -> std::io::Result<Self> {
        let root = dunce_canonicalize(root)?;
        if !root.is_dir() {
            return Err(std::io::Error::other(format!("{} is not a directory", root.display())));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Map a workspace-relative path (`a/b.cs`, `""` = root) to a real path
    /// inside the workspace.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, String> {
        if rel.contains('\\') || rel.contains(':') || rel.starts_with('/') || rel.contains('\0') {
            return Err(format!("invalid path: {rel:?}"));
        }
        let mut p = self.root.clone();
        if !rel.is_empty() {
            for seg in rel.split('/') {
                match seg {
                    "" | "." | ".." => return Err(format!("invalid path: {rel:?}")),
                    ".git" => return Err("the .git directory is not shared".into()),
                    s => p.push(s),
                }
            }
        }
        // Symlinks could point anywhere; make sure the real target is inside.
        let real = dunce_canonicalize(&p).map_err(|e| not_found(rel, e))?;
        if !real.starts_with(&self.root) {
            return Err(format!("path escapes the shared folder: {rel:?}"));
        }
        Ok(real)
    }

    /// Directory listing, honouring `.gitignore` (so `bin/`, `obj/`,
    /// `node_modules/` etc. don't flood guests).
    pub fn read_dir(&self, rel: &str) -> Result<Vec<DirEntry>, String> {
        let dir = self.resolve(rel)?;
        let walker = ignore::WalkBuilder::new(&dir)
            .max_depth(Some(1))
            .hidden(false)
            .require_git(false)
            .follow_links(false)
            .filter_entry(|e| e.file_name() != ".git")
            .build();
        let mut out = Vec::new();
        for entry in walker.flatten() {
            if entry.depth() == 0 {
                continue;
            }
            let Some(name) = entry.file_name().to_str() else { continue };
            if let Ok(e) = entry_for(name, entry.path()) {
                out.push(e);
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub fn stat(&self, rel: &str) -> Result<DirEntry, String> {
        let p = self.resolve(rel)?;
        let name = rel.rsplit('/').next().unwrap_or("");
        entry_for(name, &p).map_err(|e| not_found(rel, e))
    }

    pub fn read(&self, rel: &str) -> Result<Vec<u8>, String> {
        let p = self.resolve(rel)?;
        let len = std::fs::metadata(&p).map_err(|e| not_found(rel, e))?.len();
        if len > MAX_BINARY_FILE {
            return Err(format!("{rel} is too large to share ({len} bytes)"));
        }
        std::fs::read(&p).map_err(|e| not_found(rel, e))
    }

    /// `Ok(None)` if the file is binary and can't be a live text document.
    pub fn read_text(&self, rel: &str) -> Result<Option<String>, String> {
        let p = self.resolve(rel)?;
        let meta = std::fs::metadata(&p).map_err(|e| not_found(rel, e))?;
        if !meta.is_file() {
            return Err(format!("{rel} is not a file"));
        }
        if meta.len() > MAX_TEXT_FILE {
            return Ok(None);
        }
        let bytes = std::fs::read(&p).map_err(|e| not_found(rel, e))?;
        Ok(decode_text(bytes))
    }
}

/// UTF-8 (with optional BOM) without NUL bytes counts as text.
fn decode_text(bytes: Vec<u8>) -> Option<String> {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").map(<[u8]>::to_vec).unwrap_or(bytes);
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn entry_for(name: &str, p: &Path) -> std::io::Result<DirEntry> {
    let meta = std::fs::metadata(p)?; // follows symlinks
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(DirEntry {
        name: name.to_string(),
        kind: if meta.is_dir() { FileKind::Dir } else { FileKind::File },
        size: meta.len(),
        mtime,
    })
}

fn not_found(rel: &str, e: std::io::Error) -> String {
    format!("{rel}: {e}")
}

/// `canonicalize` without the `\\?\` prefix on Windows, so `starts_with`
/// comparisons and error messages behave.
fn dunce_canonicalize(p: &Path) -> std::io::Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    #[cfg(windows)]
    {
        if let Some(s) = c.to_str()
            && let Some(stripped) = s.strip_prefix(r"\\?\")
            && !stripped.starts_with("UNC\\")
        {
            return Ok(PathBuf::from(stripped));
        }
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Workspace) {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        std::fs::create_dir_all(r.join("src")).unwrap();
        std::fs::create_dir_all(r.join("bin")).unwrap();
        std::fs::create_dir_all(r.join(".git")).unwrap();
        std::fs::write(r.join(".gitignore"), "bin/\n").unwrap();
        std::fs::write(r.join("src/Program.cs"), "class P {}").unwrap();
        std::fs::write(r.join("bin/out.dll"), [0u8, 1, 2]).unwrap();
        std::fs::write(r.join("logo.png"), [0x89, b'P', 0, 0]).unwrap();
        std::fs::write(r.join("bom.md"), b"\xEF\xBB\xBF# hi").unwrap();
        let ws = Workspace::new(r).unwrap();
        (d, ws)
    }

    #[test]
    fn lists_root_respecting_gitignore() {
        let (_d, ws) = setup();
        let names: Vec<_> = ws.read_dir("").unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, [".gitignore", "bom.md", "logo.png", "src"]);
    }

    #[test]
    fn rejects_escapes() {
        let (_d, ws) = setup();
        for bad in ["../x", "src/../../x", "/etc/passwd", "C:/Windows", "src\\..\\..", ".git/config", "src//a"] {
            assert!(ws.resolve(bad).is_err(), "{bad} should be rejected");
        }
        assert!(ws.resolve("src/Program.cs").is_ok());
    }

    #[test]
    fn text_vs_binary() {
        let (_d, ws) = setup();
        assert_eq!(ws.read_text("src/Program.cs").unwrap().as_deref(), Some("class P {}"));
        assert_eq!(ws.read_text("logo.png").unwrap(), None);
        assert_eq!(ws.read_text("bom.md").unwrap().as_deref(), Some("# hi"));
        assert_eq!(ws.read("logo.png").unwrap().len(), 4);
    }

    #[test]
    fn stat_file_and_dir() {
        let (_d, ws) = setup();
        assert_eq!(ws.stat("src").unwrap().kind, FileKind::Dir);
        let f = ws.stat("src/Program.cs").unwrap();
        assert_eq!((f.kind, f.size, f.name.as_str()), (FileKind::File, 10, "Program.cs"));
        assert!(ws.stat("nope.txt").is_err());
    }
}
