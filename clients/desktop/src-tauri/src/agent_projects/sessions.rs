//! Reading agent session transcripts (Codex, Claude Code, WorkBuddy): the first prompt, the
//! models used and the files the session wrote.

use super::*;

/// What one session file says, before display overrides such as app-given titles.
#[derive(Debug, Default)]
pub(super) struct SessionRecord {
    pub(super) id: String,
    pub(super) title: Option<String>,
    pub(super) first_prompt: Option<String>,
    pub(super) employee_name: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) model: Option<String>,
    pub(super) created_at: Option<i64>,
    /// Absolute paths the session wrote, each with the model that wrote it.
    pub(super) writes: Vec<(String, Option<String>)>,
}

impl SessionRecord {
    pub(super) fn note_prompt(&mut self, text: &str) {
        let text = text.trim();
        if self.first_prompt.is_none() && !text.is_empty() {
            self.first_prompt = Some(truncate_chars(text, MAX_DESCRIPTION_CHARS));
        }
    }

    pub(super) fn note_write(&mut self, path: &str, model: Option<String>) {
        if self.writes.len() >= MAX_WRITES_PER_SESSION {
            return;
        }
        if let Some(path) = absolute_path(path, self.cwd.as_deref()) {
            self.writes.push((path, model));
        }
    }
}

/// Records normally hold absolute paths; relative ones resolve against the session folder.
pub(super) fn absolute_path(path: &str, cwd: Option<&str>) -> Option<String> {
    if Path::new(path).is_absolute() {
        return Some(path.to_string());
    }
    let joined = Path::new(cwd?).join(path);
    if joined.is_absolute() {
        joined.to_str().map(str::to_string)
    } else {
        None
    }
}

pub(super) fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(super) fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((index, _)) => format!("{}…", &value[..index]),
        None => value.to_string(),
    }
}

pub(super) fn title_from_prompt(prompt: &str) -> Option<String> {
    let line = prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(truncate_chars(line, MAX_TITLE_CHARS))
}

pub(super) fn str_field(value: &Value, key: &str) -> Option<String> {
    value[key]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Concatenates `text` of content items whose `type` equals `kind`.
pub(super) fn join_text(content: &Value, kind: &str) -> String {
    let Some(items) = content.as_array() else {
        return String::new();
    };
    items
        .iter()
        .filter(|item| item["type"].as_str() == Some(kind))
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn for_each_line<R: BufRead>(mut reader: R, mut handle: impl FnMut(&[u8]) -> bool) {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        if buffer.len() > MAX_LINE_BYTES {
            continue;
        }
        if !handle(&buffer) {
            break;
        }
    }
}

pub(super) fn line_head(line: &[u8]) -> &str {
    let head = &line[..line.len().min(LINE_PREFIX_SCAN_BYTES)];
    match std::str::from_utf8(head) {
        Ok(text) => text,
        // The prefix may end inside a multi-byte character.
        Err(error) => std::str::from_utf8(&head[..error.valid_up_to()]).unwrap_or_default(),
    }
}

pub(super) fn is_codex_subagent(meta: &Value) -> bool {
    meta["thread_source"].as_str() == Some("subagent") || meta["source"].get("subagent").is_some()
}

/// Codex rollout: the files of completed FileChange items, their models and the first prompt.
/// Subagent threads belong to their parent and are skipped.
pub(super) fn parse_codex<R: BufRead>(reader: R) -> Option<SessionRecord> {
    let mut session = SessionRecord::default();
    let mut subagent = false;
    for_each_line(reader, |line| {
        let head = line_head(line);
        if !CODEX_MARKERS.iter().any(|marker| head.contains(marker)) {
            return true;
        }
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        let payload = &value["payload"];
        match value["type"].as_str() {
            Some("session_meta") => {
                if is_codex_subagent(payload) {
                    subagent = true;
                    return false;
                }
                if session.id.is_empty() {
                    session.id = str_field(payload, "id")
                        .or_else(|| str_field(payload, "session_id"))
                        .unwrap_or_default();
                    session.created_at =
                        payload["timestamp"].as_str().and_then(parse_rfc3339_millis);
                    session.cwd = str_field(payload, "cwd");
                }
            }
            Some("turn_context") => {
                if let Some(model) = str_field(payload, "model") {
                    session.model = Some(model);
                }
            }
            Some("event_msg") => {
                let item = &payload["item"];
                match (payload["type"].as_str(), item["type"].as_str()) {
                    (Some("item_completed"), Some("UserMessage")) => {
                        session.note_prompt(&join_text(&item["content"], "text"));
                    }
                    // Older rollouts record the prompt as a user_message event.
                    (Some("user_message"), _) => {
                        session.note_prompt(payload["message"].as_str().unwrap_or_default());
                    }
                    (Some("item_completed"), Some("FileChange"))
                        if item["status"].as_str() == Some("completed") =>
                    {
                        for (path, change) in item["changes"].as_object().into_iter().flatten() {
                            if change["type"].as_str() == Some("delete") {
                                continue;
                            }
                            let target = change["move_path"].as_str().unwrap_or(path);
                            let model = session.model.clone();
                            session.note_write(target, model);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        true
    });
    session.title = session.first_prompt.as_deref().and_then(title_from_prompt);
    (!subagent).then_some(session)
}

/// WorkBuddy wraps the typed request in `<user_query>`; everything else in a user
/// message is injected context.
pub(super) fn workbuddy_user_query(text: &str) -> Option<String> {
    const OPEN: &str = "<user_query>";
    const CLOSE: &str = "</user_query>";
    let mut queries = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        let after = &rest[start + OPEN.len()..];
        let Some(end) = after.find(CLOSE) else { break };
        queries.push(after[..end].trim());
        rest = &after[end + CLOSE.len()..];
    }
    let query = if queries.is_empty() {
        strip_system_reminders(text)
    } else {
        queries.join("\n\n")
    };
    let query = query.trim();
    (!query.is_empty()).then(|| query.to_string())
}

pub(super) fn strip_system_reminders(text: &str) -> String {
    const OPEN: &str = "<system-reminder";
    const CLOSE: &str = "</system-reminder>";
    let mut output = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        output.push_str(&rest[..start]);
        match rest[start..].find(CLOSE) {
            Some(end) => rest = &rest[start + end + CLOSE.len()..],
            None => return output,
        }
    }
    output.push_str(rest);
    output
}

pub(super) fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let Some(hex) = bytes
                .get(index + 1..index + 3)
                .filter(|hex| hex.iter().all(u8::is_ascii_hexdigit))
            {
                let text = std::str::from_utf8(hex).unwrap_or_default();
                if let Ok(byte) = u8::from_str_radix(text, 16) {
                    output.push(byte);
                    index += 3;
                    continue;
                }
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

/// WorkBuddy expert ("buddy") name from W3C baggage, e.g. `buddyId=,buddyName=…`.
pub(super) fn workbuddy_buddy_name(value: &Value) -> Option<String> {
    let baggage = value["_meta"]["baggage"].as_str()?;
    baggage
        .split(',')
        .find_map(|item| item.trim().strip_prefix("buddyName="))
        .map(|name| percent_decode(name).trim().to_string())
        .filter(|name| !name.is_empty())
}

/// The trimmed text between `<tag>` and `</tag>`.
pub(super) fn tag_text<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = text.find(&open)? + open.len();
    let end = start + text[start..].find(&format!("</{tag}>"))?;
    Some(text[start..end].trim())
}

pub(super) fn claude_prompt(text: &str) -> Option<String> {
    let text = strip_system_reminders(text);
    // A slash command's request is its arguments.
    let text = tag_text(&text, "command-args").unwrap_or(text.trim());
    (!text.is_empty() && !CLAUDE_NON_PROMPTS.iter().any(|tag| text.starts_with(tag)))
        .then(|| text.to_string())
}

/// Claude Code transcript, which the Claude desktop app also writes: files of file tools whose
/// result arrived without an error, the models that wrote them, the title and first prompt.
pub(super) fn parse_claude<R: BufRead>(reader: R) -> SessionRecord {
    let mut session = SessionRecord::default();
    // Tool use id -> (file path, model) until its result arrives.
    let mut pending: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut summary: Option<String> = None;

    for_each_line(reader, |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        if session.id.is_empty() {
            session.id = str_field(&value, "sessionId").unwrap_or_default();
        }
        if session.cwd.is_none() {
            session.cwd = str_field(&value, "cwd");
        }
        if session.created_at.is_none() {
            session.created_at = value["timestamp"].as_str().and_then(parse_rfc3339_millis);
        }
        let message = &value["message"];
        match value["type"].as_str() {
            // Set by the user with `/rename`.
            Some("custom-title") => {
                custom_title = str_field(&value, "customTitle").or(custom_title.take());
            }
            Some("ai-title") => ai_title = str_field(&value, "aiTitle").or(ai_title.take()),
            // Older Claude Code versions summarise the session instead.
            Some("summary") if summary.is_none() => summary = str_field(&value, "summary"),
            Some("assistant") => {
                if let Some(model) =
                    str_field(message, "model").filter(|model| model != "<synthetic>")
                {
                    session.model = Some(model);
                }
                for item in message["content"].as_array().into_iter().flatten() {
                    let name = item["name"].as_str().unwrap_or_default();
                    if item["type"].as_str() != Some("tool_use")
                        || !CLAUDE_FILE_TOOLS.contains(&name)
                    {
                        continue;
                    }
                    if let (Some(id), Some(path)) = (
                        str_field(item, "id"),
                        str_field(&item["input"], "file_path"),
                    ) {
                        pending.insert(id, (path, session.model.clone()));
                    }
                }
            }
            Some("user") if value["isMeta"].as_bool() != Some(true) => {
                let mut texts = Vec::new();
                match &message["content"] {
                    Value::String(text) => texts.push(text.as_str()),
                    Value::Array(items) => {
                        for item in items {
                            match item["type"].as_str() {
                                Some("text") => texts.extend(item["text"].as_str()),
                                Some("tool_result") => {
                                    let Some((path, model)) = item["tool_use_id"]
                                        .as_str()
                                        .and_then(|id| pending.remove(id))
                                    else {
                                        continue;
                                    };
                                    if item["is_error"].as_bool() != Some(true) {
                                        session.note_write(&path, model);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                // Subagent turns kept in the transcript and the summary written by `/compact`
                // are not the user's requests.
                if value["isSidechain"].as_bool() != Some(true)
                    && value["isCompactSummary"].as_bool() != Some(true)
                {
                    if let Some(text) = claude_prompt(&texts.join("\n")) {
                        session.note_prompt(&text);
                    }
                }
            }
            _ => {}
        }
        true
    });
    session.title = custom_title
        .or(ai_title)
        .or(summary)
        .map(|title| truncate_chars(&title, MAX_TITLE_CHARS))
        .or_else(|| session.first_prompt.as_deref().and_then(title_from_prompt));
    session
}

/// WorkBuddy session: its task folder (`cwd`), title, first request, expert and model. The
/// files are found in the task folder, so tool calls are not read.
pub(super) fn parse_workbuddy<R: BufRead>(reader: R) -> SessionRecord {
    let mut session = SessionRecord::default();
    let mut ai_title: Option<String> = None;
    for_each_line(reader, |line| {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            return true;
        };
        if session.id.is_empty() {
            session.id = str_field(&value, "sessionId").unwrap_or_default();
        }
        if session.cwd.is_none() {
            session.cwd = str_field(&value, "cwd");
        }
        if session.created_at.is_none() {
            session.created_at = value["timestamp"].as_i64();
        }
        if session.employee_name.is_none() {
            session.employee_name = workbuddy_buddy_name(&value);
        }
        match (value["type"].as_str(), value["role"].as_str()) {
            (Some("ai-title"), _) => ai_title = str_field(&value, "aiTitle").or(ai_title.take()),
            // Mode switches and reminders arrive as user messages without a query.
            (Some("message"), Some("user")) => {
                if let Some(query) =
                    workbuddy_user_query(&join_text(&value["content"], "input_text"))
                {
                    session.note_prompt(&query);
                }
            }
            (Some("message"), Some("assistant")) => {
                if let Some(model) = str_field(&value["providerData"], "model") {
                    session.model = Some(model);
                }
            }
            _ => {}
        }
        true
    });
    session.title = ai_title
        .map(|title| truncate_chars(&title, MAX_TITLE_CHARS))
        .or_else(|| session.first_prompt.as_deref().and_then(title_from_prompt));
    session
}

/// Codex and Claude Code sessions that wrote nothing cannot have made a project.
pub(super) fn parse_file(source: AgentSource, path: &Path) -> Option<SessionRecord> {
    let reader = BufReader::with_capacity(256 * 1024, File::open(path).ok()?);
    let mut session = match source {
        AgentSource::Codex => parse_codex(reader)?,
        AgentSource::Claude | AgentSource::ClaudeDesktop => parse_claude(reader),
        AgentSource::Workbuddy => parse_workbuddy(reader),
        AgentSource::Fred => return None,
    };
    // Rollouts are named by time; other transcripts are named by session id.
    if session.id.is_empty() && source != AgentSource::Codex {
        session.id = path.file_stem()?.to_str()?.to_string();
    }
    let wrote = !session.writes.is_empty() || cowork_storage(path).is_some();
    let needs_writes = matches!(source, AgentSource::Codex | AgentSource::Claude);
    (valid_id(&session.id) && (wrote || !needs_writes)).then_some(session)
}

/// Thread names from a Codex `session_index.jsonl`; later lines supersede earlier ones.
pub(super) fn read_thread_names(path: &Path, titles: &mut HashMap<String, String>) {
    let Ok(file) = File::open(path) else {
        return;
    };
    for_each_line(BufReader::new(file), |line| {
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            if let (Some(id), Some(name)) =
                (str_field(&value, "id"), str_field(&value, "thread_name"))
            {
                titles.insert(id, name);
            }
        }
        true
    });
}

/// Milliseconds since the epoch for `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`.
pub(super) fn parse_rfc3339_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |start: usize, end: usize| -> Option<i64> {
        let text = value.get(start..end)?;
        text.bytes()
            .all(|byte| byte.is_ascii_digit())
            .then(|| text.parse().ok())?
    };
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }

    let mut index = 19;
    let mut fraction_millis = 0;
    if bytes.get(index) == Some(&b'.') {
        let start = index + 1;
        index = start;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == start {
            return None;
        }
        let digits: String = value[start..index]
            .chars()
            .chain(std::iter::repeat('0'))
            .take(3)
            .collect();
        fraction_millis = digits.parse::<i64>().ok()?;
    }
    let offset_minutes = match bytes.get(index)? {
        b'Z' | b'z' if index + 1 == bytes.len() => 0,
        sign @ (b'+' | b'-') if index + 6 == bytes.len() && bytes[index + 3] == b':' => {
            let total = number(index + 1, index + 3)? * 60 + number(index + 4, index + 6)?;
            if *sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let seconds = ((days * 24 + hour) * 60 + minute) * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + fraction_millis)
}

// Howard Hinnant's days_from_civil: proleptic Gregorian date to days since 1970-01-01.
pub(super) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
