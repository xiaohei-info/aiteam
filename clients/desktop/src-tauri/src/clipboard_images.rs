//! Pictures that a rich-text copy carries only inside its RTF.
//!
//! WPS (and other Qt/Office apps) put a copied passage on the clipboard as HTML whose `<img src>`
//! points at a temp file inside the app's own sandbox, which no other app may read. The same
//! pictures are embedded as hex in the RTF flavour (`\pngblip` / `\jpegblip`), but WebKit does not
//! hand that flavour to the page. This command reads the RTF straight from the system clipboard
//! so the composer can attach those pictures in place of the unreadable HTML ones.

use base64::Engine;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    pub name: String,
    pub mime: String,
    pub data_base64: String,
}

/// Same ceiling as a pasted file; a picture bigger than this is not worth decoding.
const MAX_PICTURE_BYTES: usize = 64 * 1024 * 1024;

/// Embedded PNG/JPEG pictures of an RTF document, in reading order.
pub fn rtf_pictures(rtf: &str) -> Vec<(&'static str, Vec<u8>)> {
    let bytes = rtf.as_bytes();
    let mut blips: Vec<(usize, usize, &'static str)> = [("\\pngblip", "image/png"), ("\\jpegblip", "image/jpeg")]
        .into_iter()
        .flat_map(|(keyword, mime)| rtf.match_indices(keyword).map(move |(at, _)| (at, at + keyword.len(), mime)))
        // `\pngblip` must end there, not be the prefix of a longer control word.
        .filter(|(_, end, _)| !bytes.get(*end).is_some_and(|b| b.is_ascii_alphabetic()))
        .collect();
    blips.sort_by_key(|(at, _, _)| *at);

    let mut found: Vec<(&'static str, Vec<u8>)> = Vec::new();
    for (_, end, mime) in blips {
        let (data, _) = read_hex(bytes, skip_to_picture_data(bytes, end));
        if data.is_empty() {
            continue;
        }
        // Word writes the same picture twice (\shppict and its \nonshppict fallback).
        if found.last().is_some_and(|(_, last)| *last == data) {
            continue;
        }
        found.push((mime, data));
    }
    found
}

/// Skips the control words and `{…}` groups (e.g. `{\*\blipuid …}`) between the blip keyword and
/// the hex picture data.
fn skip_to_picture_data(bytes: &[u8], mut cursor: usize) -> usize {
    loop {
        match bytes.get(cursor) {
            Some(b' ' | b'\r' | b'\n' | b'\t') => cursor += 1,
            Some(b'{') => {
                let mut depth = 0usize;
                while let Some(&b) = bytes.get(cursor) {
                    cursor += 1;
                    match b {
                        b'\\' => cursor += 1,
                        b'{' => depth += 1,
                        b'}' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some(b'\\') => {
                cursor += 1;
                while bytes.get(cursor).is_some_and(|b| b.is_ascii_alphabetic()) {
                    cursor += 1;
                }
                if bytes.get(cursor) == Some(&b'-') {
                    cursor += 1;
                }
                while bytes.get(cursor).is_some_and(|b| b.is_ascii_digit()) {
                    cursor += 1;
                }
                if bytes.get(cursor) == Some(&b' ') {
                    cursor += 1;
                }
            }
            _ => return cursor,
        }
    }
}

fn read_hex(bytes: &[u8], mut cursor: usize) -> (Vec<u8>, usize) {
    let mut data = Vec::new();
    let mut high: Option<u8> = None;
    while let Some(&b) = bytes.get(cursor) {
        let nibble = match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            b'A'..=b'F' => b - b'A' + 10,
            b' ' | b'\r' | b'\n' | b'\t' => {
                cursor += 1;
                continue;
            }
            _ => break,
        };
        cursor += 1;
        match high.take() {
            None => high = Some(nibble),
            Some(h) => {
                if data.len() >= MAX_PICTURE_BYTES {
                    return (Vec::new(), cursor);
                }
                data.push(h << 4 | nibble);
            }
        }
    }
    (data, cursor)
}

fn to_images(pictures: Vec<(&'static str, Vec<u8>)>) -> Vec<ClipboardImage> {
    pictures
        .into_iter()
        .enumerate()
        .map(|(i, (mime, data))| ClipboardImage {
            name: format!("图片{}.{}", i + 1, if mime == "image/png" { "png" } else { "jpg" }),
            mime: mime.to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(data),
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn clipboard_rtf() -> Option<String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    let types = pasteboard.types()?;
    // Standard RTF first, then app-specific flavours that are RTF too (Qt's `text--rtf`).
    let mut names: Vec<String> = types.iter().map(|t| t.to_string()).collect();
    names.retain(|name| name.to_ascii_lowercase().contains("rtf") && !name.contains("rtfd"));
    names.sort_by_key(|name| name != "public.rtf");
    names.into_iter().find_map(|name| {
        let data = pasteboard.dataForType(&NSString::from_str(&name))?;
        let bytes = data.to_vec();
        (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
    })
}

#[cfg(not(target_os = "macos"))]
fn clipboard_rtf() -> Option<String> {
    None
}

/// Pictures embedded in the RTF on the system clipboard; empty when there is none.
#[tauri::command]
pub fn read_clipboard_rtf_images() -> Vec<ClipboardImage> {
    clipboard_rtf().map(|rtf| to_images(rtf_pictures(&rtf))).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::rtf_pictures;

    const PNG_HEAD: &str = "89504e470d0a1a0a";

    #[test]
    fn reads_a_wps_style_png_after_the_blipuid_group() {
        let rtf = format!(
            "{{\\rtf1 第一段{{\\pict\\picscalex96 \\picw150 \\pich90 \\pngblip {{\\*\\blipuid 227d7166}}{PNG_HEAD}\r\n0000}}第二段}}"
        );
        let pictures = rtf_pictures(&rtf);
        assert_eq!(pictures.len(), 1);
        assert_eq!(pictures[0].0, "image/png");
        assert_eq!(pictures[0].1[..8], [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        assert_eq!(pictures[0].1.len(), 10);
    }

    #[test]
    fn keeps_reading_order_and_drops_word_duplicate_fallback() {
        let rtf = "{\\pict\\jpegblip ffd8ff}{\\nonshppict{\\pict\\jpegblip ffd8ff}}{\\pict\\pngblip 8950}";
        let pictures = rtf_pictures(rtf);
        let mimes: Vec<_> = pictures.iter().map(|(m, _)| *m).collect();
        assert_eq!(mimes, ["image/jpeg", "image/png"]);
    }

    #[test]
    fn ignores_metafiles_and_text_without_pictures() {
        assert!(rtf_pictures("{\\rtf1 hello}").is_empty());
        assert!(rtf_pictures("{\\pict\\wmetafile8 0102}").is_empty());
        assert!(rtf_pictures("{\\pict\\pngblipx 0102}").is_empty());
    }
}
