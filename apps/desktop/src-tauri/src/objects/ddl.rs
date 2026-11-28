//! Writes the DDL for creating, changing and dropping schema objects. Nothing here touches a database.

use super::model::{ChangeOptions, ChangeWarning, DatabaseDefinition, ExtensionDefinition, ObjectDefinition, Parallel, TableDefinition, TypeDefinition, Volatility};
use super::model::TypeKind;
use super::{databases, table, types};
#[cfg(test)]
use super::model::ObjectType;
use crate::error::CommandError;

/// Keywords Postgres reserves, which must be quoted to be used as names.
const RESERVED: &[&str] = &[
    "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "binary", "both", "case", "cast",
    "check", "collate", "collation", "column", "concurrently", "constraint", "create", "cross", "current_catalog", "current_date",
    "current_role", "current_schema", "current_time", "current_timestamp", "current_user", "default", "deferrable", "desc", "distinct",
    "do", "else", "end", "except", "false", "fetch", "for", "foreign", "freeze", "from", "full", "grant", "group", "having", "ilike",
    "in", "initially", "inner", "intersect", "into", "is", "isnull", "join", "lateral", "leading", "left", "like", "limit", "localtime",
    "localtimestamp", "natural", "not", "notnull", "null", "offset", "on", "only", "or", "order", "outer", "overlaps", "placing",
    "primary", "references", "returning", "right", "select", "session_user", "similar", "some", "symmetric", "system_user", "table",
    "tablesample", "then", "to", "trailing", "true", "union", "unique", "user", "using", "variadic", "verbose", "when", "where", "window",
    "with",
];

/// A name as SQL must spell it: bare when it is plain lowercase and not reserved, otherwise in double quotes.
pub fn ident(name: &str) -> String {
    let mut chars = name.chars();
    let plain = chars.next().is_some_and(|first| first.is_ascii_lowercase() || first == '_')
        && chars.all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_' || character == '$');
    if plain && !RESERVED.contains(&name) {
        return name.to_string();
    }
    format!("\"{}\"", name.replace('"', "\"\""))
}

pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", ident(schema), ident(name))
}

/// A string literal with its single quotes doubled.
pub fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The body between dollar quotes whose tag doesn't appear inside it.
pub(super) fn dollar_quoted(body: &str) -> String {
    let tag = std::iter::once(String::new())
        .chain(std::iter::once("body".to_string()))
        .chain((1..).map(|number| format!("tw{number}")))
        .find(|tag| !body.contains(&format!("${tag}$")))
        .expect("some tag is always unused");
    format!("${tag}${body}${tag}$")
}

/// The DDL a change needs and what to warn about. The caller adds the dependents of anything dropped.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Planned {
    pub statements: Vec<String>,
    pub warnings: Vec<ChangeWarning>,
    /// Whether the plan drops the original object, so its dependents should be listed.
    pub drops_original: bool,
    /// Statements that can't run in a transaction, run one by one after it commits.
    pub after_commit: Vec<String>,
    /// The numbers of the table columns the plan drops, whose dependents should be listed.
    pub dropped_columns: Vec<i16>,
    /// The names of the table constraints the plan drops, whose dependents should be listed.
    pub dropped_constraints: Vec<String>,
    /// A database the plan drops or renames, which Tidewater's own sessions must leave first.
    pub closes_database: Option<String>,
}

pub(super) fn warning(title: &str, detail: impl Into<String>) -> ChangeWarning {
    ChangeWarning { title: title.to_string(), detail: detail.into() }
}

pub(super) fn required(value: &str, field: &str) -> Result<(), CommandError> {
    if value.trim().is_empty() {
        return Err(CommandError::Invalid(format!("{field} is required.")));
    }
    Ok(())
}

fn whole_number(value: &str, field: &str) -> Result<(), CommandError> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return Err(CommandError::Invalid(format!("{field} must be a whole number.")));
    }
    Ok(())
}

pub(super) fn comment_on(target: &str, comment: &Option<String>) -> String {
    let value = comment.as_deref().filter(|text| !text.is_empty()).map_or("NULL".to_string(), literal);
    format!("COMMENT ON {target} IS {value}")
}

/// The SQL keyword for the object a definition describes.
fn keyword(definition: &ObjectDefinition) -> &'static str {
    match definition {
        ObjectDefinition::Schema { .. } => "SCHEMA",
        ObjectDefinition::Sequence { .. } => "SEQUENCE",
        ObjectDefinition::View { .. } => "VIEW",
        ObjectDefinition::MaterializedView { .. } => "MATERIALIZED VIEW",
        ObjectDefinition::Routine { procedure: false, .. } => "FUNCTION",
        ObjectDefinition::Routine { procedure: true, .. } => "PROCEDURE",
        ObjectDefinition::Table(_) => "TABLE",
        ObjectDefinition::Type(definition) if definition.kind == TypeKind::Domain => "DOMAIN",
        ObjectDefinition::Type(_) => "TYPE",
        ObjectDefinition::Extension(_) => "EXTENSION",
        ObjectDefinition::Database(_) => "DATABASE",
    }
}

/// Where a definition lives, spelled as `DROP` and `ALTER` name it. A routine with no identity arguments is named alone,
/// which Postgres accepts while its name is unique in its schema.
fn target(definition: &ObjectDefinition) -> String {
    match definition {
        ObjectDefinition::Schema { name, .. } => ident(name),
        ObjectDefinition::Sequence { schema, name, .. }
        | ObjectDefinition::View { schema, name, .. }
        | ObjectDefinition::MaterializedView { schema, name, .. } => qualified(schema, name),
        ObjectDefinition::Routine { schema, name, identity_arguments, .. } if identity_arguments.is_empty() => qualified(schema, name),
        ObjectDefinition::Routine { schema, name, identity_arguments, .. } => format!("{}({identity_arguments})", qualified(schema, name)),
        ObjectDefinition::Table(table) => qualified(&table.schema, &table.name),
        ObjectDefinition::Type(definition) => qualified(&definition.schema, &definition.name),
        ObjectDefinition::Extension(extension) => ident(&extension.name),
        ObjectDefinition::Database(database) => ident(&database.name),
    }
}

fn comment(definition: &ObjectDefinition) -> &Option<String> {
    match definition {
        ObjectDefinition::Schema { comment, .. }
        | ObjectDefinition::Sequence { comment, .. }
        | ObjectDefinition::View { comment, .. }
        | ObjectDefinition::MaterializedView { comment, .. }
        | ObjectDefinition::Routine { comment, .. } => comment,
        ObjectDefinition::Table(table) => &table.comment,
        ObjectDefinition::Type(definition) => &definition.comment,
        ObjectDefinition::Extension(extension) => &extension.comment,
        ObjectDefinition::Database(database) => &database.comment,
    }
}

fn validate(definition: &ObjectDefinition) -> Result<(), CommandError> {
    match definition {
        ObjectDefinition::Schema { name, .. } => required(name, "Name"),
        ObjectDefinition::Sequence { schema, name, data_type, increment, min_value, max_value, start, cache, .. } => {
            required(schema, "Schema")?;
            required(name, "Name")?;
            required(data_type, "Data type")?;
            for (value, field) in [(increment, "Increment"), (start, "Start"), (cache, "Cache")] {
                whole_number(value, field)?;
            }
            for (value, field) in [(min_value, "Minimum"), (max_value, "Maximum")] {
                if !value.is_empty() {
                    whole_number(value, field)?;
                }
            }
            Ok(())
        }
        ObjectDefinition::View { schema, name, query, .. } | ObjectDefinition::MaterializedView { schema, name, query, .. } => {
            required(schema, "Schema")?;
            required(name, "Name")?;
            required(query, "Query")
        }
        ObjectDefinition::Routine { procedure, schema, name, returns, language, body, .. } => {
            required(schema, "Schema")?;
            required(name, "Name")?;
            if !procedure {
                required(returns, "Returns")?;
            }
            required(language, "Language")?;
            required(body, "Body")
        }
        ObjectDefinition::Table(table) => table::validate(table),
        ObjectDefinition::Type(definition) => types::validate(definition),
        ObjectDefinition::Extension(extension) => databases::validate_extension(extension),
        ObjectDefinition::Database(database) => databases::validate_database(database),
    }
}

/// A sequence's options as `CREATE SEQUENCE` and `ALTER SEQUENCE` spell them, one clause each, always in this order.
fn sequence_options(data_type: &str, increment: &str, min_value: &str, max_value: &str, start: &str, cache: &str, cycle: bool) -> Vec<String> {
    let bound = |keyword: &str, value: &str| if value.is_empty() { format!("NO {keyword}") } else { format!("{keyword} {value}") };
    vec![
        format!("AS {data_type}"),
        format!("INCREMENT BY {increment}"),
        bound("MINVALUE", min_value),
        bound("MAXVALUE", max_value),
        format!("START WITH {start}"),
        format!("CACHE {cache}"),
        if cycle { "CYCLE".to_string() } else { "NO CYCLE".to_string() },
    ]
}

fn volatility(value: Volatility) -> &'static str {
    match value {
        Volatility::Volatile => "VOLATILE",
        Volatility::Stable => "STABLE",
        Volatility::Immutable => "IMMUTABLE",
    }
}

fn parallel(value: Parallel) -> &'static str {
    match value {
        Parallel::Unsafe => "PARALLEL UNSAFE",
        Parallel::Restricted => "PARALLEL RESTRICTED",
        Parallel::Safe => "PARALLEL SAFE",
    }
}

/// The statement that creates `definition`, or replaces it in place when `or_replace`.
fn create_statement(definition: &ObjectDefinition, options: ChangeOptions, or_replace: bool) -> String {
    let replace = if or_replace { "OR REPLACE " } else { "" };
    match definition {
        ObjectDefinition::Schema { name, .. } => format!("CREATE SCHEMA {}", ident(name)),
        ObjectDefinition::Sequence { schema, name, data_type, increment, min_value, max_value, start, cache, cycle, .. } => {
            let clauses = sequence_options(data_type, increment, min_value, max_value, start, cache, *cycle);
            format!("CREATE SEQUENCE {}\n  {}", qualified(schema, name), clauses.join("\n  "))
        }
        ObjectDefinition::View { schema, name, query, .. } => format!("CREATE {replace}VIEW {} AS\n{query}", qualified(schema, name)),
        ObjectDefinition::MaterializedView { schema, name, query, .. } => {
            let data = if options.with_data { "WITH DATA" } else { "WITH NO DATA" };
            format!("CREATE MATERIALIZED VIEW {} AS\n{query}\n{data}", qualified(schema, name))
        }
        ObjectDefinition::Routine {
            procedure, schema, name, arguments, returns, language, volatility: volatile, security_definer, parallel: parallel_safety, body, ..
        } => {
            let security = if *security_definer { "SECURITY DEFINER" } else { "SECURITY INVOKER" };
            let mut lines = vec![format!("CREATE {replace}{} {}({arguments})", keyword(definition), qualified(schema, name))];
            if !procedure {
                lines.push(format!("RETURNS {returns}"));
            }
            lines.push(format!("LANGUAGE {language}"));
            if !procedure {
                lines.push(volatility(*volatile).to_string());
                lines.push(parallel(*parallel_safety).to_string());
            }
            lines.push(security.to_string());
            lines.push(format!("AS {}", dollar_quoted(body)));
            lines.join("\n")
        }
        ObjectDefinition::Table(table) => table::create_statement(table),
        ObjectDefinition::Type(definition) => types::create_statement(definition),
        ObjectDefinition::Extension(extension) => databases::create_extension(extension, options),
        ObjectDefinition::Database(database) => databases::create_database(database),
    }
}

fn create(definition: &ObjectDefinition, options: ChangeOptions) -> Planned {
    let mut statements = vec![create_statement(definition, options, false)];
    if comment(definition).as_deref().is_some_and(|text| !text.is_empty()) {
        statements.push(comment_on(&format!("{} {}", keyword(definition), target(definition)), comment(definition)));
    }
    let mut warnings = Vec::new();
    if let ObjectDefinition::Table(table) = definition {
        statements.extend(table::after_create(table));
        warnings.extend(table::row_security_warning(table));
    }
    if let ObjectDefinition::Database(_) = definition {
        return Planned { after_commit: statements, ..Planned::default() };
    }
    Planned { statements, warnings, ..Planned::default() }
}

fn drop(definition: &ObjectDefinition, options: ChangeOptions) -> Planned {
    if let ObjectDefinition::Database(database) = definition {
        let force = if options.force { " WITH (FORCE)" } else { "" };
        return Planned {
            after_commit: vec![format!("DROP DATABASE {}{force}", ident(&database.name))],
            drops_original: true,
            closes_database: Some(database.name.clone()),
            ..Planned::default()
        };
    }
    let cascade = if options.cascade { " CASCADE" } else { "" };
    let mut warnings = Vec::new();
    if options.cascade {
        warnings.push(warning("Drops its dependents too", "CASCADE also drops every object listed as depending on it."));
    }
    Planned { statements: vec![format!("DROP {} {}{cascade}", keyword(definition), target(definition))], warnings, drops_original: true, ..Planned::default() }
}

/// Where a definition sits: its schema (empty for a schema) and its name.
fn location(definition: &ObjectDefinition) -> (&str, &str) {
    match definition {
        ObjectDefinition::Schema { name, .. } => ("", name),
        ObjectDefinition::Sequence { schema, name, .. }
        | ObjectDefinition::View { schema, name, .. }
        | ObjectDefinition::MaterializedView { schema, name, .. }
        | ObjectDefinition::Routine { schema, name, .. } => (schema, name),
        ObjectDefinition::Table(table) => (&table.schema, &table.name),
        ObjectDefinition::Type(definition) => (&definition.schema, &definition.name),
        ObjectDefinition::Extension(ExtensionDefinition { name, .. }) | ObjectDefinition::Database(DatabaseDefinition { name, .. }) => ("", name),
    }
}

/// `ALTER … RENAME` and `ALTER … SET SCHEMA` statements that move `original` to `to`'s name and schema.
fn relocate(original: &ObjectDefinition, to: &ObjectDefinition) -> Vec<String> {
    let (from_schema, from_name) = location(original);
    let (to_schema, to_name) = location(to);
    let kind = keyword(original);
    let mut statements = Vec::new();
    if from_name != to_name {
        statements.push(format!("ALTER {kind} {} RENAME TO {}", target(original), ident(to_name)));
    }
    if from_schema != to_schema {
        let renamed = with_location(original, from_schema, to_name);
        statements.push(format!("ALTER {kind} {} SET SCHEMA {}", target(&renamed), ident(to_schema)));
    }
    statements
}

fn with_location(definition: &ObjectDefinition, schema: &str, name: &str) -> ObjectDefinition {
    let mut located = definition.clone();
    match &mut located {
        ObjectDefinition::Schema { name: current, .. } => *current = name.to_string(),
        ObjectDefinition::Sequence { schema: current_schema, name: current, .. }
        | ObjectDefinition::View { schema: current_schema, name: current, .. }
        | ObjectDefinition::MaterializedView { schema: current_schema, name: current, .. }
        | ObjectDefinition::Routine { schema: current_schema, name: current, .. } => {
            *current_schema = schema.to_string();
            *current = name.to_string();
        }
        ObjectDefinition::Table(TableDefinition { schema: current_schema, name: current, .. })
        | ObjectDefinition::Type(TypeDefinition { schema: current_schema, name: current, .. }) => {
            *current_schema = schema.to_string();
            *current = name.to_string();
        }
        ObjectDefinition::Extension(ExtensionDefinition { name: current, .. }) | ObjectDefinition::Database(DatabaseDefinition { name: current, .. }) => {
            *current = name.to_string();
        }
    }
    located
}

fn query_of(definition: &ObjectDefinition) -> &str {
    match definition {
        ObjectDefinition::View { query, .. } | ObjectDefinition::MaterializedView { query, .. } => query,
        _ => "",
    }
}

fn recreate(original: &ObjectDefinition, changed: &ObjectDefinition, options: ChangeOptions, title: &str, detail: &str) -> Planned {
    let mut planned = drop(original, options);
    planned.warnings.insert(0, warning(title, detail));
    planned.statements.push(create_statement(changed, options, false));
    if comment(changed).as_deref().is_some_and(|text| !text.is_empty()) {
        planned.statements.push(comment_on(&format!("{} {}", keyword(changed), target(&renamed_identity(changed))), comment(changed)));
    }
    planned
}

/// How `GRANT … ON` names a definition once its DDL has run: by its new name and schema, and for a routine that was
/// just created or recreated by name alone, since the identity arguments it carries may be its old ones.
pub(super) fn grant_target(definition: &ObjectDefinition, fresh: bool) -> String {
    if fresh { target(&renamed_identity(definition)) } else { target(definition) }
}

/// A changed routine is named by schema and name alone once recreated, since its old identity arguments may not match.
fn renamed_identity(definition: &ObjectDefinition) -> ObjectDefinition {
    let mut copy = definition.clone();
    if let ObjectDefinition::Routine { identity_arguments, .. } = &mut copy {
        identity_arguments.clear();
    }
    copy
}

/// The statements that give `original` the new name, schema and comment of `changed`, after its other changes.
fn relocate_and_comment(original: &ObjectDefinition, changed: &ObjectDefinition, statements: &mut Vec<String>) {
    statements.extend(relocate(original, changed));
    if comment(original) != comment(changed) {
        let renamed = with_location(original, location(changed).0, location(changed).1);
        statements.push(comment_on(&format!("{} {}", keyword(changed), target(&renamed)), comment(changed)));
    }
}

fn alter(original: &ObjectDefinition, changed: &ObjectDefinition, options: ChangeOptions, view_replaceable: bool) -> Result<Planned, CommandError> {
    let own_alter = match (original, changed) {
        (ObjectDefinition::Table(before), ObjectDefinition::Table(after)) => Some(table::alter(before, after, options)?),
        (ObjectDefinition::Type(before), ObjectDefinition::Type(after)) => Some(types::alter(before, after, options)?),
        (ObjectDefinition::Extension(before), ObjectDefinition::Extension(after)) => Some(databases::alter_extension(before, after)?),
        (ObjectDefinition::Database(before), ObjectDefinition::Database(after)) => Some(databases::alter_database(before, after)?),
        _ => None,
    };
    if let Some(mut planned) = own_alter {
        relocate_and_comment(original, changed, &mut planned.statements);
        return Ok(planned);
    }
    let query_changed = query_of(original) != query_of(changed);
    let signature_changed = matches!(
        (original, changed),
        (
            ObjectDefinition::Routine { procedure: was_procedure, arguments: old_arguments, returns: old_returns, .. },
            ObjectDefinition::Routine { procedure, arguments, returns, .. },
        ) if was_procedure != procedure || old_arguments != arguments || old_returns != returns
    );
    match changed {
        ObjectDefinition::View { .. } if query_changed && !view_replaceable => {
            return Ok(recreate(original, changed, options, "Drops and recreates the view", "Its columns change in a way CREATE OR REPLACE can't apply."));
        }
        ObjectDefinition::MaterializedView { .. } if query_changed => {
            let mut planned = recreate(original, changed, options, "Drops and recreates the materialized view", "Its query changed.");
            if options.with_data {
                planned.warnings.push(warning("Runs the new query to fill it", "Reads of the materialized view wait until the query finishes."));
            }
            return Ok(planned);
        }
        ObjectDefinition::Routine { .. } if signature_changed => {
            return Ok(recreate(original, changed, options, "Drops and recreates the routine", "Its arguments, return type or kind changed."));
        }
        _ => {}
    }
    let (schema, name) = location(original);
    let mut statements = Vec::new();
    match (original, changed) {
        (_, ObjectDefinition::View { .. }) if query_changed => statements.push(create_statement(&with_location(changed, schema, name), options, true)),
        (
            ObjectDefinition::Sequence { data_type: a, increment: b, min_value: c, max_value: d, start: e, cache: f, cycle: g, .. },
            ObjectDefinition::Sequence { data_type, increment, min_value, max_value, start, cache, cycle, .. },
        ) => {
            let before = sequence_options(a, b, c, d, e, f, *g);
            let after = sequence_options(data_type, increment, min_value, max_value, start, cache, *cycle);
            let changes: Vec<String> = after.into_iter().zip(before).filter(|(new, old)| new != old).map(|(new, _)| new).collect();
            if !changes.is_empty() {
                statements.push(format!("ALTER SEQUENCE {} {}", target(original), changes.join(" ")));
            }
        }
        (
            ObjectDefinition::Routine { language: a, volatility: b, security_definer: c, parallel: d, body: e, .. },
            ObjectDefinition::Routine { language, volatility, security_definer, parallel, body, .. },
        ) if (a, b, c, d, e) != (language, volatility, security_definer, parallel, body) => {
            statements.push(create_statement(&with_location(changed, schema, name), options, true));
        }
        _ => {}
    }
    relocate_and_comment(original, changed, &mut statements);
    Ok(Planned { statements, ..Planned::default() })
}

/// The DDL that turns `original` into `changed`: creates when there is no original, drops when there is no change.
/// `view_replaceable` says whether a changed view query keeps the view's columns, which only the server can tell.
pub fn plan(original: Option<&ObjectDefinition>, changed: Option<&ObjectDefinition>, options: ChangeOptions, view_replaceable: bool) -> Result<Planned, CommandError> {
    match (original, changed) {
        (None, Some(changed)) => validate(changed).map(|()| create(changed, options)),
        (Some(original), None) => Ok(drop(original, options)),
        (Some(original), Some(changed)) if original.object_type() == changed.object_type() => {
            validate(changed).and_then(|()| alter(original, changed, options, view_replaceable))
        }
        (Some(_), Some(_)) => Err(CommandError::Invalid("An object can't change into a different kind of object.".into())),
        (None, None) => Err(CommandError::Invalid("There is nothing to change.".into())),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn options() -> ChangeOptions {
        ChangeOptions { cascade: false, with_data: true, force: false }
    }

    /// The definition with some fields replaced, by their names in the shared JSON form.
    fn with(definition: &ObjectDefinition, changes: Value) -> ObjectDefinition {
        let mut value = serde_json::to_value(definition).unwrap();
        for (key, field) in changes.as_object().unwrap() {
            value[key] = field.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    fn schema(name: &str, comment: Option<&str>) -> ObjectDefinition {
        ObjectDefinition::Schema { name: name.into(), comment: comment.map(str::to_string) }
    }

    fn sequence() -> ObjectDefinition {
        ObjectDefinition::Sequence {
            schema: "public".into(),
            name: "order_numbers".into(),
            data_type: "bigint".into(),
            increment: "1".into(),
            min_value: "".into(),
            max_value: "".into(),
            start: "1".into(),
            cache: "1".into(),
            cycle: false,
            comment: None,
        }
    }

    fn view(query: &str) -> ObjectDefinition {
        ObjectDefinition::View { schema: "public".into(), name: "recent".into(), query: query.into(), comment: None }
    }

    fn materialized(query: &str) -> ObjectDefinition {
        ObjectDefinition::MaterializedView { schema: "public".into(), name: "totals".into(), query: query.into(), comment: None }
    }

    fn function() -> ObjectDefinition {
        ObjectDefinition::Routine {
            procedure: false,
            schema: "public".into(),
            name: "add_one".into(),
            arguments: "n integer DEFAULT 1".into(),
            identity_arguments: "n integer".into(),
            returns: "integer".into(),
            language: "sql".into(),
            volatility: Volatility::Immutable,
            security_definer: false,
            parallel: Parallel::Safe,
            body: "SELECT n + 1".into(),
            comment: None,
        }
    }

    fn statements(original: Option<&ObjectDefinition>, changed: Option<&ObjectDefinition>) -> Vec<String> {
        plan(original, changed, options(), true).unwrap().statements
    }

    fn refusal(definition: ObjectDefinition) -> CommandError {
        plan(None, Some(&definition), options(), true).unwrap_err()
    }

    #[test]
    fn names_are_bare_when_plain_and_quoted_when_mixed_case_spaced_reserved_or_holding_quotes() {
        assert_eq!(
            [ident("orders"), ident("_tmp$1"), ident("Order"), ident("order"), ident("two words"), ident("say \"hi\""), ident(""), ident("1st")],
            ["orders", "_tmp$1", "\"Order\"", "\"order\"", "\"two words\"", "\"say \"\"hi\"\"\"", "\"\"", "\"1st\""]
        );
        assert_eq!(literal("it's"), "'it''s'");
    }

    #[test]
    fn a_body_is_dollar_quoted_with_a_tag_it_does_not_contain() {
        assert_eq!(dollar_quoted("SELECT 1"), "$$SELECT 1$$");
        assert_eq!(dollar_quoted("SELECT '$$'"), "$body$SELECT '$$'$body$");
        assert_eq!(dollar_quoted("$$ and $body$"), "$tw1$$$ and $body$$tw1$");
    }

    #[test]
    fn a_new_schema_is_created_with_its_comment_and_a_blank_comment_is_left_out() {
        assert_eq!(statements(None, Some(&schema("Sales", Some("Orders and invoices")))), [
            "CREATE SCHEMA \"Sales\"",
            "COMMENT ON SCHEMA \"Sales\" IS 'Orders and invoices'"
        ]);
        assert_eq!(statements(None, Some(&schema("sales", Some("")))), ["CREATE SCHEMA sales"]);
    }

    #[test]
    fn renaming_a_schema_and_clearing_its_comment() {
        let original = schema("sales", Some("old"));
        assert_eq!(statements(Some(&original), Some(&schema("revenue", None))), [
            "ALTER SCHEMA sales RENAME TO revenue",
            "COMMENT ON SCHEMA revenue IS NULL"
        ]);
        assert_eq!(statements(Some(&original), Some(&original)), Vec::<String>::new());
    }

    #[test]
    fn a_new_sequence_spells_every_option_with_no_bound_for_blank_limits() {
        let bounded = with(&sequence(), json!({ "min_value": "-5", "max_value": "100", "cycle": true }));
        assert_eq!(statements(None, Some(&sequence())), [
            "CREATE SEQUENCE public.order_numbers\n  AS bigint\n  INCREMENT BY 1\n  NO MINVALUE\n  NO MAXVALUE\n  START WITH 1\n  CACHE 1\n  NO CYCLE"
        ]);
        assert!(statements(None, Some(&bounded))[0].ends_with("MINVALUE -5\n  MAXVALUE 100\n  START WITH 1\n  CACHE 1\n  CYCLE"));
    }

    #[test]
    fn editing_a_sequence_alters_only_what_changed_then_renames_moves_and_comments() {
        let changed = with(&sequence(), json!({ "schema": "billing", "name": "invoice_numbers", "increment": "10", "cache": "20", "comment": "Invoice numbers" }));
        assert_eq!(statements(Some(&sequence()), Some(&changed)), [
            "ALTER SEQUENCE public.order_numbers INCREMENT BY 10 CACHE 20",
            "ALTER SEQUENCE public.order_numbers RENAME TO invoice_numbers",
            "ALTER SEQUENCE public.invoice_numbers SET SCHEMA billing",
            "COMMENT ON SEQUENCE billing.invoice_numbers IS 'Invoice numbers'"
        ]);
    }

    #[test]
    fn renaming_a_sequence_or_routine_alone_leaves_its_options_and_body_untouched() {
        assert_eq!(statements(Some(&sequence()), Some(&with(&sequence(), json!({ "name": "numbers" })))), [
            "ALTER SEQUENCE public.order_numbers RENAME TO numbers"
        ]);
        assert_eq!(statements(Some(&function()), Some(&with(&function(), json!({ "name": "plus_one" })))), [
            "ALTER FUNCTION public.add_one(n integer) RENAME TO plus_one"
        ]);
    }

    #[test]
    fn sequence_numbers_must_be_whole() {
        for (field, value, message) in [
            ("increment", "1.5", "Increment must be a whole number."),
            ("max_value", "lots", "Maximum must be a whole number."),
            ("start", "-", "Start must be a whole number."),
        ] {
            assert_eq!(refusal(with(&sequence(), json!({ field: value }))), CommandError::Invalid(message.into()));
        }
    }

    #[test]
    fn every_kind_reports_its_missing_required_fields() {
        for (definition, field, label) in [
            (schema("x", None), "name", "Name"),
            (sequence(), "schema", "Schema"),
            (sequence(), "name", "Name"),
            (sequence(), "data_type", "Data type"),
            (view("SELECT 1"), "schema", "Schema"),
            (view("SELECT 1"), "name", "Name"),
            (view("SELECT 1"), "query", "Query"),
            (function(), "schema", "Schema"),
            (function(), "name", "Name"),
            (function(), "returns", "Returns"),
            (function(), "language", "Language"),
            (function(), "body", "Body"),
        ] {
            assert_eq!(refusal(with(&definition, json!({ field: " " }))), CommandError::Invalid(format!("{label} is required.")), "{field}");
        }
    }

    #[test]
    fn a_view_query_that_keeps_its_columns_is_replaced_in_place_before_a_rename() {
        let changed = with(&view("SELECT 2 AS n"), json!({ "name": "latest" }));
        assert_eq!(statements(Some(&view("SELECT 1 AS n")), Some(&changed)), [
            "CREATE OR REPLACE VIEW public.recent AS\nSELECT 2 AS n",
            "ALTER VIEW public.recent RENAME TO latest"
        ]);
        assert_eq!(statements(None, Some(&view("SELECT 1"))), ["CREATE VIEW public.recent AS\nSELECT 1"]);
    }

    #[test]
    fn a_view_whose_columns_change_is_dropped_and_recreated_with_its_comment_and_a_warning() {
        let changed = with(&view("SELECT 1 AS a"), json!({ "comment": "Recent orders" }));

        let planned = plan(Some(&view("SELECT 1 AS n")), Some(&changed), ChangeOptions { cascade: true, with_data: true, force: false }, false).unwrap();

        assert_eq!(planned.statements, [
            "DROP VIEW public.recent CASCADE",
            "CREATE VIEW public.recent AS\nSELECT 1 AS a",
            "COMMENT ON VIEW public.recent IS 'Recent orders'"
        ]);
        assert_eq!(planned.warnings.iter().map(|warning| warning.title.as_str()).collect::<Vec<_>>(), [
            "Drops and recreates the view",
            "Drops its dependents too"
        ]);
        assert!(planned.drops_original);
    }

    #[test]
    fn a_materialized_view_whose_query_changes_is_recreated_and_filled_or_left_empty() {
        let filled = plan(Some(&materialized("SELECT 1")), Some(&materialized("SELECT 2")), options(), true).unwrap();
        let empty = plan(Some(&materialized("SELECT 1")), Some(&materialized("SELECT 2")), ChangeOptions { cascade: false, with_data: false, force: false }, true).unwrap();

        assert_eq!(filled.statements, ["DROP MATERIALIZED VIEW public.totals", "CREATE MATERIALIZED VIEW public.totals AS\nSELECT 2\nWITH DATA"]);
        assert_eq!(filled.warnings.len(), 2);
        assert_eq!((empty.statements[1].ends_with("WITH NO DATA"), empty.warnings.len()), (true, 1));
    }

    #[test]
    fn a_materialized_view_is_renamed_and_moved_without_being_rebuilt() {
        let moved = with(&materialized("SELECT 1"), json!({ "schema": "reports" }));
        assert_eq!(statements(Some(&materialized("SELECT 1")), Some(&moved)), ["ALTER MATERIALIZED VIEW public.totals SET SCHEMA reports"]);
    }

    #[test]
    fn a_new_function_and_procedure_spell_their_attributes_and_comment_by_name() {
        let commented = with(&function(), json!({ "comment": "Adds one", "identity_arguments": "" }));
        let procedure = with(&function(), json!({ "procedure": true, "returns": "", "security_definer": true }));

        assert_eq!(statements(None, Some(&commented)), [
            "CREATE FUNCTION public.add_one(n integer DEFAULT 1)\nRETURNS integer\nLANGUAGE sql\nIMMUTABLE\nPARALLEL SAFE\nSECURITY INVOKER\nAS $$SELECT n + 1$$",
            "COMMENT ON FUNCTION public.add_one IS 'Adds one'"
        ]);
        assert_eq!(statements(None, Some(&procedure)), [
            "CREATE PROCEDURE public.add_one(n integer DEFAULT 1)\nLANGUAGE sql\nSECURITY DEFINER\nAS $$SELECT n + 1$$"
        ]);
    }

    #[test]
    fn every_volatility_and_parallel_setting_is_spelled() {
        let spelled = |volatility: &str, parallel: &str| statements(None, Some(&with(&function(), json!({ "volatility": volatility, "parallel": parallel })))).remove(0);
        assert!(spelled("volatile", "unsafe").contains("VOLATILE\nPARALLEL UNSAFE"));
        assert!(spelled("stable", "restricted").contains("STABLE\nPARALLEL RESTRICTED"));
    }

    #[test]
    fn editing_a_routine_body_replaces_it_in_place_then_renames_and_moves_it_by_its_identity() {
        let changed = with(&function(), json!({ "schema": "util", "name": "increment", "body": "SELECT n + 2", "comment": "Adds two" }));
        assert_eq!(statements(Some(&function()), Some(&changed)), [
            "CREATE OR REPLACE FUNCTION public.add_one(n integer DEFAULT 1)\nRETURNS integer\nLANGUAGE sql\nIMMUTABLE\nPARALLEL SAFE\nSECURITY INVOKER\nAS $$SELECT n + 2$$",
            "ALTER FUNCTION public.add_one(n integer) RENAME TO increment",
            "ALTER FUNCTION public.increment(n integer) SET SCHEMA util",
            "COMMENT ON FUNCTION util.increment(n integer) IS 'Adds two'"
        ]);
    }

    #[test]
    fn a_routine_whose_arguments_return_type_or_kind_change_is_dropped_and_recreated_and_commented_by_name() {
        for change in [json!({ "arguments": "n bigint" }), json!({ "returns": "bigint", "comment": "Now bigger" })] {
            let planned = plan(Some(&function()), Some(&with(&function(), change)), options(), true).unwrap();
            assert_eq!(planned.statements[0], "DROP FUNCTION public.add_one(n integer)");
            assert!(planned.statements[1].contains(" public.add_one("));
            assert_eq!(planned.warnings[0].title, "Drops and recreates the routine");
        }
        let recommented = plan(Some(&function()), Some(&with(&function(), json!({ "returns": "bigint", "comment": "Now bigger" }))), options(), true).unwrap();
        assert_eq!(recommented.statements[2], "COMMENT ON FUNCTION public.add_one IS 'Now bigger'");
    }

    #[test]
    fn dropping_names_the_object_with_cascade_only_when_asked() {
        assert_eq!(statements(Some(&sequence()), None), ["DROP SEQUENCE public.order_numbers"]);
        let cascaded = plan(Some(&schema("sales", None)), None, ChangeOptions { cascade: true, with_data: false, force: false }, true).unwrap();
        assert_eq!(cascaded.statements, ["DROP SCHEMA sales CASCADE"]);
        assert_eq!(cascaded.warnings[0].title, "Drops its dependents too");
    }

    #[test]
    fn a_change_between_kinds_or_with_nothing_to_change_is_refused() {
        assert_eq!(plan(Some(&schema("a", None)), Some(&sequence()), options(), true), Err(CommandError::Invalid("An object can't change into a different kind of object.".into())));
        assert_eq!(plan(None, None, options(), true), Err(CommandError::Invalid("There is nothing to change.".into())));
        assert_eq!(plan(Some(&function()), Some(&with(&function(), json!({ "body": "" }))), options(), true), Err(CommandError::Invalid("Body is required.".into())));
    }

    #[test]
    fn a_definition_knows_its_object_type() {
        let procedure = with(&function(), json!({ "procedure": true }));
        assert_eq!(
            [schema("a", None), sequence(), view("SELECT 1"), materialized("SELECT 1"), function(), procedure].map(|definition| definition.object_type()),
            [ObjectType::Schema, ObjectType::Sequence, ObjectType::View, ObjectType::MaterializedView, ObjectType::Function, ObjectType::Procedure]
        );
    }

    fn table_definition(schema: &str, name: &str) -> super::super::model::TableDefinition {
        super::super::model::TableDefinition {
            schema: schema.into(),
            name: name.into(),
            comment: None,
            partition_key: None,
            columns: Vec::new(),
            constraints: Vec::new(),
            indexes: Vec::new(),
            row_security: false,
            force_row_security: false,
            policies: Vec::new(),
        }
    }

    fn table(schema: &str, name: &str, comment: Option<&str>) -> ObjectDefinition {
        ObjectDefinition::Table(super::super::model::TableDefinition { comment: comment.map(str::to_string), ..table_definition(schema, name) })
    }

    #[test]
    fn a_table_is_created_commented_moved_and_dropped_like_any_object() {
        let created = plan(None, Some(&table("public", "notes", Some("scratch"))), options(), true).unwrap();
        let moved = plan(Some(&table("public", "notes", None)), Some(&table("archive", "old_notes", Some("kept"))), options(), true).unwrap();
        let dropped = plan(Some(&table("public", "notes", None)), None, options(), true).unwrap();
        let invalid = plan(None, Some(&table("public", "", None)), options(), true).map_err(|error| error.to_string());

        assert_eq!(created.statements, ["CREATE TABLE public.notes (\n  \n)", "COMMENT ON TABLE public.notes IS 'scratch'"]);
        assert_eq!(moved.statements, [
            "ALTER TABLE public.notes RENAME TO old_notes",
            "ALTER TABLE public.old_notes SET SCHEMA archive",
            "COMMENT ON TABLE archive.old_notes IS 'kept'",
        ]);
        assert_eq!((dropped.statements, dropped.drops_original), (vec!["DROP TABLE public.notes".to_string()], true));
        assert_eq!(invalid.unwrap_err(), "Name is required.");
        assert_eq!(table("a", "b", None).object_type(), ObjectType::Table);
    }

    #[test]
    fn a_table_change_the_designer_refuses_is_refused_by_the_plan() {
        let with_generated = |generated: &str| {
            ObjectDefinition::Table(super::super::model::TableDefinition {
                columns: vec![super::super::model::ColumnDefinition {
                    number: Some(1),
                    name: "c".into(),
                    data_type: "int".into(),
                    not_null: false,
                    default: String::new(),
                    identity: super::super::model::Identity::None,
                    generated: generated.into(),
                    using: String::new(),
                    comment: None,
                }],
                ..table_definition("public", "t")
            })
        };
        assert!(plan(Some(&with_generated("1")), Some(&with_generated("2")), options(), true).is_err());
    }


    fn database(name: &str, comment: Option<&str>) -> ObjectDefinition {
        ObjectDefinition::Database(DatabaseDefinition {
            name: name.into(),
            owner: String::new(),
            encoding: String::new(),
            template: String::new(),
            collation: String::new(),
            ctype: String::new(),
            connection_limit: -1,
            comment: comment.map(str::to_string),
        })
    }

    fn domain(name: &str, schema: &str) -> ObjectDefinition {
        ObjectDefinition::Type(TypeDefinition {
            schema: schema.into(),
            name: name.into(),
            comment: None,
            kind: TypeKind::Domain,
            values: Vec::new(),
            attributes: Vec::new(),
            base_type: "integer".into(),
            default: String::new(),
            not_null: false,
            checks: Vec::new(),
        })
    }

    fn extension(schema: &str, comment: Option<&str>) -> ObjectDefinition {
        ObjectDefinition::Extension(ExtensionDefinition { name: "citext".into(), schema: schema.into(), version: String::new(), comment: comment.map(str::to_string) })
    }

    #[test]
    fn a_database_is_created_and_dropped_outside_the_transaction_and_names_itself_as_closed_when_renamed_or_dropped() {
        let created = plan(None, Some(&database("shop", Some("orders and stock"))), options(), true).unwrap();
        let forced = plan(Some(&database("shop", None)), None, ChangeOptions { force: true, ..options() }, true).unwrap();
        let renamed = plan(Some(&database("shop", None)), Some(&database("store", Some("renamed"))), options(), true).unwrap();

        assert_eq!((created.statements.len(), created.after_commit), (0, vec![
            "CREATE DATABASE shop".to_string(),
            "COMMENT ON DATABASE shop IS 'orders and stock'".to_string()
        ]));
        assert_eq!((forced.after_commit, forced.closes_database), (vec!["DROP DATABASE shop WITH (FORCE)".to_string()], Some("shop".to_string())));
        assert_eq!(plan(Some(&database("shop", None)), None, options(), true).unwrap().after_commit, ["DROP DATABASE shop"]);
        assert_eq!(renamed.statements, ["ALTER DATABASE shop RENAME TO store", "COMMENT ON DATABASE store IS 'renamed'"]);
        assert_eq!(renamed.closes_database.as_deref(), Some("shop"));
        assert_eq!(database("a", None).object_type(), ObjectType::Database);
    }

    #[test]
    fn a_domain_is_named_as_a_domain_and_other_types_and_extensions_move_and_take_comments() {
        let moved = plan(Some(&domain("qty", "public")), Some(&domain("quantity", "sales")), options(), true).unwrap();
        let dropped = plan(Some(&domain("qty", "public")), None, options(), true).unwrap();
        let enum_type = ObjectDefinition::Type(TypeDefinition { kind: TypeKind::Enum, ..type_of(&domain("mood", "public")) });
        let commented = plan(Some(&enum_type), Some(&with(&enum_type, json!({ "comment": "how it went" }))), options(), true).unwrap();
        let extended = plan(Some(&extension("public", None)), Some(&extension("ext", Some("case-blind text"))), options(), true).unwrap();
        let installed = plan(None, Some(&extension("", None)), options(), true).unwrap();
        let created_domain = plan(None, Some(&domain("qty", "public")), options(), true).unwrap();
        assert_eq!(created_domain.statements, ["CREATE DOMAIN public.qty AS integer"]);

        assert_eq!(moved.statements, ["ALTER DOMAIN public.qty RENAME TO quantity", "ALTER DOMAIN public.quantity SET SCHEMA sales"]);
        assert_eq!(dropped.statements, ["DROP DOMAIN public.qty"]);
        assert_eq!(commented.statements, ["COMMENT ON TYPE public.mood IS 'how it went'"]);
        assert_eq!(extended.statements, ["ALTER EXTENSION citext SET SCHEMA ext", "COMMENT ON EXTENSION citext IS 'case-blind text'"]);
        assert_eq!(installed.statements, ["CREATE EXTENSION citext"]);
        assert_eq!([enum_type.object_type(), extension("", None).object_type()], [ObjectType::Type, ObjectType::Extension]);
        assert!(plan(None, Some(&database("", None)), options(), true).is_err());
        assert!(plan(Some(&domain("a", "public")), Some(&ObjectDefinition::Type(TypeDefinition { base_type: "text".into(), ..type_of(&domain("a", "public")) })), options(), true).is_err());
        assert!(plan(None, Some(&domain("", "public")), options(), true).is_err());
        assert!(plan(None, Some(&extension("", None)), options(), true).is_ok());
        assert!(plan(Some(&extension("", None)), Some(&ObjectDefinition::Extension(ExtensionDefinition { name: "x".into(), schema: String::new(), version: String::new(), comment: None })), options(), true).is_err());
        assert!(plan(Some(&database("a", None)), Some(&ObjectDefinition::Database(DatabaseDefinition { encoding: "LATIN1".into(), ..database_of(&database("a", None)) })), options(), true).is_err());
    }

    fn type_of(definition: &ObjectDefinition) -> TypeDefinition {
        serde_json::from_value(serde_json::to_value(definition).unwrap()).unwrap()
    }

    fn database_of(definition: &ObjectDefinition) -> DatabaseDefinition {
        serde_json::from_value(serde_json::to_value(definition).unwrap()).unwrap()
    }
}
