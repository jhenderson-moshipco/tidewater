//! Writes the DDL for what travels beside an object's definition: its grants, and a table's or view's triggers.
//! Nothing here touches a database.

use super::ddl::{dollar_quoted, grant_target, ident, qualified, required};
use super::model::{ExtrasChange, Grant, ObjectDefinition, ObjectType, TriggerDefinition, TriggerEvent, TriggerTiming, TypeKind};
use crate::error::CommandError;

/// The privileges an object of this kind can be granted, in the order a grid shows them.
pub fn privileges_of(object_type: ObjectType) -> &'static [&'static str] {
    match object_type {
        ObjectType::Table | ObjectType::View | ObjectType::MaterializedView => &["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
        ObjectType::Sequence => &["USAGE", "SELECT", "UPDATE"],
        ObjectType::Function | ObjectType::Procedure => &["EXECUTE"],
        ObjectType::Schema => &["USAGE", "CREATE"],
        ObjectType::Type => &["USAGE"],
        ObjectType::Database => &["CONNECT", "CREATE", "TEMPORARY"],
        ObjectType::Extension => &[],
    }
}

/// What Postgres grants PUBLIC on a new object of this kind, which a new or recreated object starts with.
pub fn default_grants(object_type: ObjectType) -> Vec<Grant> {
    let public = |privilege: &str| Grant { grantee: "PUBLIC".into(), privilege: privilege.into(), grantable: false };
    match object_type {
        ObjectType::Function | ObjectType::Procedure => vec![public("EXECUTE")],
        ObjectType::Type => vec![public("USAGE")],
        ObjectType::Database => vec![public("CONNECT"), public("TEMPORARY")],
        _ => Vec::new(),
    }
}

/// The relation a definition's triggers are on, for the kinds that have triggers.
fn relation(definition: &ObjectDefinition) -> Option<String> {
    match definition {
        ObjectDefinition::Table(table) => Some(qualified(&table.schema, &table.name)),
        ObjectDefinition::View { schema, name, .. } => Some(qualified(schema, name)),
        _ => None,
    }
}

/// The keyword `GRANT … ON` takes for a definition, or `None` for a kind with no privileges.
fn grant_keyword(definition: &ObjectDefinition) -> Option<&'static str> {
    match definition {
        ObjectDefinition::Table(_) | ObjectDefinition::View { .. } | ObjectDefinition::MaterializedView { .. } => Some("TABLE"),
        ObjectDefinition::Sequence { .. } => Some("SEQUENCE"),
        ObjectDefinition::Routine { procedure: false, .. } => Some("FUNCTION"),
        ObjectDefinition::Routine { procedure: true, .. } => Some("PROCEDURE"),
        ObjectDefinition::Schema { .. } => Some("SCHEMA"),
        ObjectDefinition::Type(definition) if definition.kind == TypeKind::Domain => Some("DOMAIN"),
        ObjectDefinition::Type(_) => Some("TYPE"),
        ObjectDefinition::Database(_) => Some("DATABASE"),
        ObjectDefinition::Extension(_) => None,
    }
}

fn grantee(name: &str) -> String {
    if name == "PUBLIC" { name.to_string() } else { ident(name) }
}

/// Grant and revoke statements, one per grantee and kind of change, that turn `original` into `changed`.
fn grant_statements(on: &str, original: &[Grant], changed: &[Grant]) -> Vec<String> {
    let find = |list: &[Grant], grant: &Grant| list.iter().find(|candidate| candidate.grantee == grant.grantee && candidate.privilege == grant.privilege).cloned();
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new();
    let mut add = |prefix: String, suffix: String, privilege: &str| match groups.iter_mut().find(|(head, tail, _)| *head == prefix && *tail == suffix) {
        Some((_, _, privileges)) => privileges.push(privilege.to_string()),
        None => groups.push((prefix, suffix, vec![privilege.to_string()])),
    };
    for grant in original {
        match find(changed, grant) {
            None => add("REVOKE".into(), format!(" ON {on} FROM {}", grantee(&grant.grantee)), &grant.privilege),
            Some(kept) if grant.grantable && !kept.grantable => add("REVOKE GRANT OPTION FOR".into(), format!(" ON {on} FROM {}", grantee(&grant.grantee)), &grant.privilege),
            Some(_) => {}
        }
    }
    for grant in changed {
        let before = find(original, grant);
        if before.as_ref().is_none_or(|before| grant.grantable && !before.grantable) {
            let option = if grant.grantable { " WITH GRANT OPTION" } else { "" };
            add("GRANT".into(), format!(" ON {on} TO {}{option}", grantee(&grant.grantee)), &grant.privilege);
        }
    }
    groups.into_iter().map(|(prefix, suffix, privileges)| format!("{prefix} {}{suffix}", privileges.join(", "))).collect()
}

fn timing(value: TriggerTiming) -> &'static str {
    match value {
        TriggerTiming::Before => "BEFORE",
        TriggerTiming::After => "AFTER",
        TriggerTiming::InsteadOf => "INSTEAD OF",
    }
}

fn event_sql(event: TriggerEvent, update_columns: &[String]) -> String {
    let columns: Vec<String> = update_columns.iter().map(|column| column.trim()).filter(|column| !column.is_empty()).map(ident).collect();
    match event {
        TriggerEvent::Insert => "INSERT".into(),
        TriggerEvent::Update if columns.is_empty() => "UPDATE".into(),
        TriggerEvent::Update => format!("UPDATE OF {}", columns.join(", ")),
        TriggerEvent::Delete => "DELETE".into(),
        TriggerEvent::Truncate => "TRUNCATE".into(),
    }
}

/// A trigger's statements: its new function first when it brings one, then `CREATE TRIGGER`, then disabling it.
fn create_trigger(trigger: &TriggerDefinition, on: &str) -> Vec<String> {
    let mut statements = Vec::new();
    if trigger.new_function {
        statements.push(format!("CREATE FUNCTION {}() RETURNS trigger LANGUAGE plpgsql AS {}", trigger.function.trim(), dollar_quoted(&trigger.body)));
    }
    let events: Vec<String> = trigger.events.iter().map(|event| event_sql(*event, &trigger.update_columns)).collect();
    let each = if trigger.for_each_row { "ROW" } else { "STATEMENT" };
    let when = if trigger.when.trim().is_empty() { String::new() } else { format!("\n  WHEN ({})", trigger.when.trim()) };
    statements.push(format!(
        "CREATE TRIGGER {} {} {} ON {on}\n  FOR EACH {each}{when}\n  EXECUTE FUNCTION {}({})",
        ident(&trigger.name),
        timing(trigger.timing),
        events.join(" OR "),
        trigger.function.trim(),
        trigger.arguments.trim()
    ));
    if !trigger.enabled {
        statements.push(format!("ALTER TABLE {on} DISABLE TRIGGER {}", ident(&trigger.name)));
    }
    statements
}

/// Whether two triggers fire the same way, leaving aside their names and whether they are enabled.
fn same_trigger(left: &TriggerDefinition, right: &TriggerDefinition) -> bool {
    let firing = |trigger: &TriggerDefinition| TriggerDefinition { original_name: None, name: String::new(), enabled: true, ..trigger.clone() };
    firing(left) == firing(right)
}

fn trigger_statements(on: &str, original: &[TriggerDefinition], changed: &[TriggerDefinition]) -> Vec<String> {
    let kept = |trigger: &TriggerDefinition| changed.iter().any(|candidate| candidate.original_name.as_deref() == Some(&trigger.name));
    let mut statements: Vec<String> = original.iter().filter(|trigger| !kept(trigger)).map(|trigger| format!("DROP TRIGGER {} ON {on}", ident(&trigger.name))).collect();
    for trigger in changed {
        let before = original.iter().find(|candidate| trigger.original_name.as_deref() == Some(&candidate.name));
        match before {
            Some(before) if same_trigger(before, trigger) => {
                if before.name != trigger.name {
                    statements.push(format!("ALTER TRIGGER {} ON {on} RENAME TO {}", ident(&before.name), ident(&trigger.name)));
                }
                if before.enabled != trigger.enabled {
                    statements.push(format!("ALTER TABLE {on} {} TRIGGER {}", if trigger.enabled { "ENABLE" } else { "DISABLE" }, ident(&trigger.name)));
                }
            }
            Some(before) => {
                statements.push(format!("DROP TRIGGER {} ON {on}", ident(&before.name)));
                statements.extend(create_trigger(trigger, on));
            }
            None => statements.extend(create_trigger(trigger, on)),
        }
    }
    statements
}

/// Checks the changed triggers are complete. Postgres can't disable a trigger on a view, so one there stays enabled.
pub fn validate(change: &ExtrasChange, on_view: bool) -> Result<(), CommandError> {
    for trigger in &change.changed.triggers {
        if on_view && !trigger.enabled {
            return Err(CommandError::Invalid("A trigger on a view can't be disabled.".into()));
        }
        required(&trigger.name, "Each trigger's name")?;
        if trigger.events.is_empty() {
            return Err(CommandError::Invalid("A trigger needs at least one event.".into()));
        }
        required(&trigger.function, "Each trigger's function")?;
        if trigger.new_function {
            required(&trigger.body, "A new trigger function's body")?;
        }
    }
    Ok(())
}

/// The statements that bring `definition`'s triggers and grants from `change.original` to `change.changed`, run after
/// its own DDL. A `fresh` object, just created or recreated, has no triggers yet and only the grants Postgres gives
/// its kind.
pub fn plan(change: &ExtrasChange, definition: &ObjectDefinition, fresh: bool) -> Result<Vec<String>, CommandError> {
    validate(change, matches!(definition, ObjectDefinition::View { .. }))?;
    let mut statements = Vec::new();
    if let Some(on) = relation(definition) {
        let original: &[TriggerDefinition] = if fresh { &[] } else { &change.original.triggers };
        statements.extend(trigger_statements(&on, original, &change.changed.triggers));
    }
    if let Some(keyword) = grant_keyword(definition) {
        let defaults = default_grants(definition.object_type());
        let original = if fresh { &defaults } else { &change.original.grants };
        statements.extend(grant_statements(&format!("{keyword} {}", grant_target(definition, fresh)), original, &change.changed.grants));
    }
    Ok(statements)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::objects::model::{DatabaseDefinition, ExtensionDefinition, ObjectExtras, Parallel, TableDefinition, TypeDefinition, Volatility};

    fn grant(grantee: &str, privilege: &str, grantable: bool) -> Grant {
        Grant { grantee: grantee.into(), privilege: privilege.into(), grantable }
    }

    fn trigger(original_name: Option<&str>, name: &str) -> TriggerDefinition {
        TriggerDefinition {
            original_name: original_name.map(str::to_string),
            name: name.into(),
            timing: TriggerTiming::Before,
            events: vec![TriggerEvent::Update],
            update_columns: Vec::new(),
            for_each_row: true,
            when: String::new(),
            function: "touch".into(),
            arguments: String::new(),
            new_function: false,
            body: String::new(),
            enabled: true,
        }
    }

    fn table() -> ObjectDefinition {
        ObjectDefinition::Table(TableDefinition {
            schema: "public".into(),
            name: "orders".into(),
            comment: None,
            partition_key: None,
            columns: Vec::new(),
            constraints: Vec::new(),
            indexes: Vec::new(),
            row_security: false,
            force_row_security: false,
            policies: Vec::new(),
        })
    }

    fn view() -> ObjectDefinition {
        ObjectDefinition::View { schema: "public".into(), name: "open_orders".into(), query: "SELECT 1".into(), comment: None }
    }

    fn function(identity_arguments: &str) -> ObjectDefinition {
        ObjectDefinition::Routine {
            procedure: false,
            schema: "public".into(),
            name: "total".into(),
            arguments: "a integer".into(),
            identity_arguments: identity_arguments.into(),
            returns: "integer".into(),
            language: "sql".into(),
            volatility: Volatility::Volatile,
            security_definer: false,
            parallel: Parallel::Unsafe,
            body: "SELECT a".into(),
            comment: None,
        }
    }

    fn change(original: ObjectExtras, changed: ObjectExtras) -> ExtrasChange {
        ExtrasChange { original, changed }
    }

    fn grants(list: Vec<Grant>) -> ObjectExtras {
        ObjectExtras { grants: list, triggers: Vec::new() }
    }

    fn triggers(list: Vec<TriggerDefinition>) -> ObjectExtras {
        ObjectExtras { grants: Vec::new(), triggers: list }
    }

    #[test]
    fn grants_are_added_revoked_and_given_or_stripped_of_their_option_one_statement_per_grantee_and_kind() {
        let original = grants(vec![grant("app", "SELECT", false), grant("app", "INSERT", true), grant("audit", "SELECT", false), grant("PUBLIC", "SELECT", false)]);
        let changed = grants(vec![
            grant("app", "SELECT", true),
            grant("app", "INSERT", false),
            grant("app", "UPDATE", false),
            grant("app", "DELETE", false),
            grant("PUBLIC", "SELECT", false),
            grant("Reporting", "SELECT", true),
        ]);

        assert_eq!(plan(&change(original, changed), &table(), false).unwrap(), [
            "REVOKE GRANT OPTION FOR INSERT ON TABLE public.orders FROM app",
            "REVOKE SELECT ON TABLE public.orders FROM audit",
            "GRANT SELECT ON TABLE public.orders TO app WITH GRANT OPTION",
            "GRANT UPDATE, DELETE ON TABLE public.orders TO app",
            "GRANT SELECT ON TABLE public.orders TO \"Reporting\" WITH GRANT OPTION",
        ]);
    }

    #[test]
    fn a_new_or_recreated_object_starts_from_the_grants_postgres_gives_its_kind() {
        let recreated = plan(&change(grants(vec![grant("app", "EXECUTE", false)]), grants(Vec::new())), &function("a integer"), true).unwrap();
        let kept = plan(&change(grants(Vec::new()), grants(vec![grant("PUBLIC", "EXECUTE", false)])), &function("a integer"), false).unwrap();
        let fresh_type = ObjectDefinition::Type(TypeDefinition {
            schema: "public".into(),
            name: "qty".into(),
            comment: None,
            kind: TypeKind::Domain,
            values: Vec::new(),
            attributes: Vec::new(),
            base_type: "integer".into(),
            default: String::new(),
            not_null: false,
            checks: Vec::new(),
        });

        assert_eq!(recreated, ["REVOKE EXECUTE ON FUNCTION public.total FROM PUBLIC"]);
        assert_eq!(kept, ["GRANT EXECUTE ON FUNCTION public.total(a integer) TO PUBLIC"]);
        assert_eq!(plan(&change(grants(Vec::new()), grants(default_grants(ObjectType::Type))), &fresh_type, true).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn each_kind_grants_on_its_own_keyword_and_an_extension_has_no_grants() {
        let added = grants(vec![grant("app", "USAGE", false)]);
        let on = |definition: ObjectDefinition| plan(&change(ObjectExtras::default(), added.clone()), &definition, false).unwrap();
        let database = ObjectDefinition::Database(DatabaseDefinition {
            name: "shop".into(),
            owner: String::new(),
            encoding: String::new(),
            template: String::new(),
            collation: String::new(),
            ctype: String::new(),
            connection_limit: -1,
            comment: None,
        });
        let sequence = ObjectDefinition::Sequence {
            schema: "public".into(),
            name: "ids".into(),
            data_type: "bigint".into(),
            increment: "1".into(),
            min_value: String::new(),
            max_value: String::new(),
            start: "1".into(),
            cache: "1".into(),
            cycle: false,
            comment: None,
        };
        let mut routine = serde_json::to_value(function("")).unwrap();
        routine["procedure"] = serde_json::json!(true);
        let procedure: ObjectDefinition = serde_json::from_value(routine).unwrap();
        let matview = ObjectDefinition::MaterializedView { schema: "public".into(), name: "totals".into(), query: "SELECT 1".into(), comment: None };
        let enum_type = ObjectDefinition::Type(TypeDefinition { kind: TypeKind::Enum, ..serde_json::from_value(serde_json::json!({
            "schema": "public", "name": "mood", "comment": null, "kind": "enum", "values": [], "attributes": [], "base_type": "",
            "default": "", "not_null": false, "checks": []
        })).unwrap() });
        let extension = ObjectDefinition::Extension(ExtensionDefinition { name: "citext".into(), schema: String::new(), version: String::new(), comment: None });

        assert_eq!(
            [on(database), on(sequence), on(procedure), on(matview), on(enum_type), on(ObjectDefinition::Schema { name: "sales".into(), comment: None })]
                .map(|statements| statements[0].clone()),
            [
                "GRANT USAGE ON DATABASE shop TO app",
                "GRANT USAGE ON SEQUENCE public.ids TO app",
                "GRANT USAGE ON PROCEDURE public.total TO app",
                "GRANT USAGE ON TABLE public.totals TO app",
                "GRANT USAGE ON TYPE public.mood TO app",
                "GRANT USAGE ON SCHEMA sales TO app",
            ]
        );
        assert_eq!(on(extension), Vec::<String>::new());
        assert_eq!(
            [ObjectType::Table, ObjectType::Sequence, ObjectType::Function, ObjectType::Schema, ObjectType::Type, ObjectType::Database, ObjectType::Extension]
                .map(|kind| privileges_of(kind).len()),
            [7, 3, 1, 2, 1, 3, 0]
        );
        assert_eq!(default_grants(ObjectType::Database).len(), 2);
    }

    #[test]
    fn a_trigger_is_created_with_its_events_columns_condition_and_arguments_and_a_new_function_first() {
        let mut full = trigger(None, "audit");
        full.timing = TriggerTiming::After;
        full.events = vec![TriggerEvent::Insert, TriggerEvent::Update, TriggerEvent::Delete, TriggerEvent::Truncate];
        full.update_columns = vec!["total".into(), " ".into()];
        full.for_each_row = false;
        full.when = " true ".into();
        full.function = "public.log_change".into();
        full.arguments = "'orders'".into();
        full.new_function = true;
        full.body = "BEGIN RETURN NULL; END".into();
        full.enabled = false;
        let instead = TriggerDefinition { timing: TriggerTiming::InsteadOf, events: vec![TriggerEvent::Insert], ..trigger(None, "write_through") };

        assert_eq!(plan(&change(ObjectExtras::default(), triggers(vec![full])), &table(), false).unwrap(), [
            "CREATE FUNCTION public.log_change() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$",
            "CREATE TRIGGER audit AFTER INSERT OR UPDATE OF total OR DELETE OR TRUNCATE ON public.orders\n  FOR EACH STATEMENT\n  WHEN (true)\n  EXECUTE FUNCTION public.log_change('orders')",
            "ALTER TABLE public.orders DISABLE TRIGGER audit",
        ]);
        assert_eq!(plan(&change(ObjectExtras::default(), triggers(vec![instead])), &view(), false).unwrap(), [
            "CREATE TRIGGER write_through INSTEAD OF INSERT ON public.open_orders\n  FOR EACH ROW\n  EXECUTE FUNCTION touch()",
        ]);
    }

    #[test]
    fn a_trigger_is_renamed_or_switched_on_and_off_in_place_and_any_other_change_drops_and_recreates_it() {
        let original = triggers(vec![trigger(Some("a"), "a"), trigger(Some("b"), "b"), trigger(Some("c"), "c"), trigger(Some("gone"), "gone")]);
        let changed = triggers(vec![
            TriggerDefinition { enabled: false, ..trigger(Some("a"), "renamed") },
            TriggerDefinition { for_each_row: false, ..trigger(Some("b"), "b") },
            trigger(Some("c"), "c"),
        ]);
        let mut back_on = original.clone();
        back_on.triggers[0].enabled = false;

        assert_eq!(plan(&change(original.clone(), changed), &table(), false).unwrap(), [
            "DROP TRIGGER gone ON public.orders",
            "ALTER TRIGGER a ON public.orders RENAME TO renamed",
            "ALTER TABLE public.orders DISABLE TRIGGER renamed",
            "DROP TRIGGER b ON public.orders",
            "CREATE TRIGGER b BEFORE UPDATE ON public.orders\n  FOR EACH STATEMENT\n  EXECUTE FUNCTION touch()",
        ]);
        assert_eq!(plan(&change(back_on, original.clone()), &table(), false).unwrap()[0], "ALTER TABLE public.orders ENABLE TRIGGER a");
        assert_eq!(plan(&change(original.clone(), original.clone()), &table(), true).unwrap().len(), 4);
        assert_eq!(plan(&change(original.clone(), original), &function(""), false).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn an_incomplete_trigger_or_one_disabled_on_a_view_is_refused() {
        let refused = |trigger: TriggerDefinition, on: ObjectDefinition| plan(&change(ObjectExtras::default(), triggers(vec![trigger])), &on, false).unwrap_err().to_string();
        assert_eq!(
            [
                refused(trigger(None, ""), table()),
                refused(TriggerDefinition { events: Vec::new(), ..trigger(None, "t") }, table()),
                refused(TriggerDefinition { function: " ".into(), ..trigger(None, "t") }, table()),
                refused(TriggerDefinition { new_function: true, ..trigger(None, "t") }, table()),
                refused(TriggerDefinition { enabled: false, ..trigger(None, "t") }, view()),
            ],
            [
                "Each trigger's name is required.",
                "A trigger needs at least one event.",
                "Each trigger's function is required.",
                "A new trigger function's body is required.",
                "A trigger on a view can't be disabled.",
            ]
        );
    }
}
