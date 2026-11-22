//! Splits editor text into statements the way psql does, ignoring semicolons inside strings, comments,
//! quoted names, dollar-quoted bodies and `BEGIN ATOMIC` routine bodies.

use serde::Serialize;
use ts_rs::TS;

/// Where a statement sits in the editor text, in UTF-16 code units as the editor counts them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "query.ts")]
pub struct StatementSpan {
    pub from: u32,
    pub to: u32,
}

/// One statement's text and where it sits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Statement<'a> {
    pub text: &'a str,
    pub span: StatementSpan,
}

struct Scanner<'a> {
    sql: &'a str,
    chars: Vec<(usize, char)>,
    /// The UTF-16 offset of each char, plus one entry for the end of the text.
    utf16: Vec<u32>,
    at: usize,
}

fn is_word_start(character: char) -> bool {
    character.is_alphabetic() || character == '_' || !character.is_ascii()
}

fn is_word_part(character: char) -> bool {
    is_word_start(character) || character.is_ascii_digit() || character == '$'
}

fn is_tag_part(character: char) -> bool {
    is_word_start(character) || character.is_ascii_digit()
}

impl<'a> Scanner<'a> {
    fn new(sql: &'a str) -> Self {
        let chars: Vec<(usize, char)> = sql.char_indices().collect();
        let mut utf16 = Vec::with_capacity(chars.len() + 1);
        let mut offset = 0u32;
        for (_, character) in &chars {
            utf16.push(offset);
            offset += u32::try_from(character.len_utf16()).unwrap_or(2);
        }
        utf16.push(offset);
        Scanner { sql, chars, utf16, at: 0 }
    }

    fn peek(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.at + ahead).map(|(_, character)| *character)
    }

    fn byte(&self, index: usize) -> usize {
        self.chars.get(index).map_or(self.sql.len(), |(byte, _)| *byte)
    }

    /// Skips past the closing `quote`, where a doubled quote stands for itself and `backslash` escapes the next char.
    fn skip_quoted(&mut self, quote: char, backslash: bool) {
        self.at += 1;
        while let Some(character) = self.peek(0) {
            self.at += 1;
            if backslash && character == '\\' {
                self.at += 1;
            } else if character == quote {
                if self.peek(0) != Some(quote) {
                    return;
                }
                self.at += 1;
            }
        }
    }

    fn skip_line_comment(&mut self) {
        while let Some(character) = self.peek(0) {
            self.at += 1;
            if character == '\n' {
                return;
            }
        }
    }

    fn skip_block_comment(&mut self) {
        let mut depth = 0usize;
        while let Some(character) = self.peek(0) {
            if character == '/' && self.peek(1) == Some('*') {
                depth += 1;
                self.at += 2;
            } else if character == '*' && self.peek(1) == Some('/') {
                depth -= 1;
                self.at += 2;
                if depth == 0 {
                    return;
                }
            } else {
                self.at += 1;
            }
        }
    }

    /// The length in chars of a dollar-quote opener such as `$$` or `$body$` at the current position.
    fn dollar_tag(&self) -> Option<usize> {
        let mut length = 1;
        while let Some(character) = self.peek(length) {
            if character == '$' {
                return Some(length + 1);
            }
            if !is_tag_part(character) || (length == 1 && character.is_ascii_digit()) {
                return None;
            }
            length += 1;
        }
        None
    }

    fn skip_dollar_quoted(&mut self, tag_length: usize) {
        let tag: Vec<char> = (0..tag_length).filter_map(|ahead| self.peek(ahead)).collect();
        self.at += tag_length;
        while self.peek(0).is_some() {
            if (0..tag_length).all(|ahead| self.peek(ahead) == Some(tag[ahead])) {
                self.at += tag_length;
                return;
            }
            self.at += 1;
        }
    }

    fn word(&mut self) -> String {
        let start = self.at;
        while self.peek(0).is_some_and(is_word_part) {
            self.at += 1;
        }
        self.sql[self.byte(start)..self.byte(self.at)].to_lowercase()
    }
}

/// Tracks `BEGIN ... END` nesting inside `CREATE [OR REPLACE] FUNCTION|PROCEDURE`, where a semicolon doesn't end the statement.
#[derive(Default)]
struct RoutineDepth {
    words: Vec<String>,
    depth: usize,
}

impl RoutineDepth {
    fn is_routine(&self) -> bool {
        let routine = |word: Option<&String>| word.is_some_and(|word| word == "function" || word == "procedure");
        let first = |index: usize| self.words.get(index).map(String::as_str);
        first(0) == Some("create")
            && (routine(self.words.get(1)) || (first(1) == Some("or") && first(2) == Some("replace") && routine(self.words.get(3))))
    }

    fn see(&mut self, word: String) {
        if self.is_routine() {
            match word.as_str() {
                "begin" | "case" => self.depth += 1,
                "end" => self.depth = self.depth.saturating_sub(1),
                _ => {}
            }
        }
        if self.words.len() < 4 {
            self.words.push(word);
        }
    }
}

/// The statements in `sql`, each without its semicolon or surrounding whitespace. Text that holds only comments is skipped.
pub fn split(sql: &str) -> Vec<Statement<'_>> {
    let mut scanner = Scanner::new(sql);
    let mut statements = Vec::new();
    let mut start: Option<usize> = None;
    let mut end = 0usize;
    let mut has_token = false;
    let mut routine = RoutineDepth::default();

    while let Some(character) = scanner.peek(0) {
        if character.is_whitespace() {
            scanner.at += 1;
            continue;
        }
        if character == ';' && routine.depth == 0 {
            push(&mut statements, &scanner, start, end, has_token);
            (start, has_token, routine) = (None, false, RoutineDepth::default());
            scanner.at += 1;
            continue;
        }
        start.get_or_insert(scanner.at);
        let next = scanner.peek(1);
        match character {
            '-' if next == Some('-') => scanner.skip_line_comment(),
            '/' if next == Some('*') => scanner.skip_block_comment(),
            _ => {
                has_token = true;
                match character {
                    '\'' => scanner.skip_quoted('\'', false),
                    '"' => scanner.skip_quoted('"', false),
                    '$' => match scanner.dollar_tag() {
                        Some(length) => scanner.skip_dollar_quoted(length),
                        None => scanner.at += 1,
                    },
                    'e' | 'E' if next == Some('\'') => {
                        scanner.at += 1;
                        scanner.skip_quoted('\'', true);
                    }
                    _ if is_word_start(character) => {
                        let word = scanner.word();
                        routine.see(word);
                    }
                    _ => scanner.at += 1,
                }
            }
        }
        end = scanner.at;
    }
    push(&mut statements, &scanner, start, end, has_token);
    statements
}

fn push<'a>(statements: &mut Vec<Statement<'a>>, scanner: &Scanner<'a>, start: Option<usize>, end: usize, has_token: bool) {
    let Some(start) = start.filter(|_| has_token) else {
        return;
    };
    let text = scanner.sql[scanner.byte(start)..scanner.byte(end)].trim_end();
    let trimmed = scanner.chars[start..end].iter().rev().take_while(|(_, character)| character.is_whitespace()).count();
    let span = StatementSpan { from: scanner.utf16[start], to: scanner.utf16[end - trimmed] };
    statements.push(Statement { text, span });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str) -> Vec<&str> {
        split(sql).into_iter().map(|statement| statement.text).collect()
    }

    #[test]
    fn semicolons_end_statements_and_each_is_trimmed() {
        let statements = split("SELECT 1;\n  SELECT 2  ;\n");
        assert_eq!(statements.iter().map(|statement| statement.text).collect::<Vec<_>>(), ["SELECT 1", "SELECT 2"]);
        assert_eq!(statements[1].span, StatementSpan { from: 12, to: 20 });
    }

    #[test]
    fn the_last_statement_needs_no_semicolon() {
        assert_eq!(texts("SELECT 1; SELECT 2"), ["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn semicolons_inside_strings_quoted_names_and_comments_do_not_split() {
        let sql = "SELECT 'a;b', 'it''s;', \"c;d\", \"x\"\"y;\" -- e;f\n, 1 /* g; /* nested; */ h; */; SELECT 2";
        assert_eq!(texts(sql), ["SELECT 'a;b', 'it''s;', \"c;d\", \"x\"\"y;\" -- e;f\n, 1 /* g; /* nested; */ h; */", "SELECT 2"]);
    }

    #[test]
    fn backslash_escapes_a_quote_only_in_an_e_string() {
        assert_eq!(texts(r"SELECT E'it\'s;', e'\\'; SELECT 'a\'; SELECT 3"), [r"SELECT E'it\'s;', e'\\'", r"SELECT 'a\'", "SELECT 3"]);
    }

    #[test]
    fn dollar_quoted_bodies_do_not_split_but_parameters_and_dollar_names_do() {
        let sql = "DO $$ BEGIN PERFORM 1; END $$; SELECT $tag$ a;$$; $tag$; SELECT $1; SELECT price$usd; SELECT $a b$; SELECT 6";
        assert_eq!(
            texts(sql),
            ["DO $$ BEGIN PERFORM 1; END $$", "SELECT $tag$ a;$$; $tag$", "SELECT $1", "SELECT price$usd", "SELECT $a b$", "SELECT 6"]
        );
    }

    #[test]
    fn unterminated_strings_comments_and_dollar_quotes_run_to_the_end() {
        assert_eq!(texts("SELECT 'abc; SELECT 2"), ["SELECT 'abc; SELECT 2"]);
        assert_eq!(texts("SELECT 1 /* never closed; SELECT 2"), ["SELECT 1 /* never closed; SELECT 2"]);
        assert_eq!(texts("SELECT $$ body; SELECT 2"), ["SELECT $$ body; SELECT 2"]);
        assert_eq!(texts("SELECT $abc"), ["SELECT $abc"]);
    }

    #[test]
    fn a_begin_atomic_routine_body_keeps_its_semicolons() {
        let sql = "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END; \
                   CREATE PROCEDURE p() BEGIN ATOMIC SELECT 1; END; CREATE TABLE t (x int); BEGIN; END";
        assert_eq!(
            texts(sql),
            [
                "CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END",
                "CREATE PROCEDURE p() BEGIN ATOMIC SELECT 1; END",
                "CREATE TABLE t (x int)",
                "BEGIN",
                "END",
            ]
        );
    }

    #[test]
    fn an_end_with_no_open_begin_in_a_routine_does_not_underflow() {
        assert_eq!(texts("CREATE FUNCTION f() END; SELECT 2"), ["CREATE FUNCTION f() END", "SELECT 2"]);
    }

    #[test]
    fn text_with_only_comments_and_whitespace_has_no_statements() {
        assert_eq!(texts("-- just a note\n; /* x */ ;  \n"), Vec::<&str>::new());
        assert_eq!(texts(""), Vec::<&str>::new());
    }

    #[test]
    fn a_leading_comment_stays_with_its_statement_and_a_trailing_one_too() {
        assert_eq!(texts("/*+ SeqScan(t) */ SELECT 1 -- note\n;"), ["/*+ SeqScan(t) */ SELECT 1 -- note"]);
    }

    #[test]
    fn spans_count_utf16_code_units() {
        let statements = split("SELECT '😀'; SELECT 2");
        assert_eq!(statements[0].span, StatementSpan { from: 0, to: 11 });
        assert_eq!(statements[1].span, StatementSpan { from: 13, to: 21 });
    }
}
