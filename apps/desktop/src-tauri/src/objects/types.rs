//! Writes the DDL that creates and changes enums, composite types, domains and ranges. Nothing here touches a database.

use std::collections::HashSet;

use super::ddl::{Planned, ident, literal, qualified, required, warning};
use super::model::{ChangeOptions, DomainCheck, TypeAttribute, TypeDefinition, TypeKind};
use crate::error::CommandError;

fn invalid(message: &str) -> CommandError {
    CommandError::Invalid(message.to_string())
}

fn unique<'a>(names: impl Iterator<Item = &'a str>, duplicate: &str) -> Result<(), CommandError> {
    let mut seen = HashSet::new();
    for name in names {
        if !seen.insert(name) {
            return Err(CommandError::Invalid(format!("{duplicate} {name}.")));
        }
    }
    Ok(())
}

pub fn validate(definition: &TypeDefinition) -> Result<(), CommandError> {
    required(&definition.schema, "Schema")?;
    required(&definition.name, "Name")?;
    match definition.kind {
        TypeKind::Enum => {
            if definition.values.iter().any(|value| value.label.is_empty()) {
                return Err(invalid("Each value needs a label."));
            }
            unique(definition.values.iter().map(|value| value.label.as_str()), "Two values are labelled")
        }
        TypeKind::Composite => {
            for attribute in &definition.attributes {
                required(&attribute.name, "Each attribute's name")?;
                required(&attribute.data_type, "Each attribute's type")?;
            }
            unique(definition.attributes.iter().map(|attribute| attribute.name.as_str()), "Two attributes are named")
        }
        TypeKind::Domain => {
            required(&definition.base_type, "The base type")?;
            for check in &definition.checks {
                if check.original_name.is_some() && check.name.trim().is_empty() {
                    return Err(invalid("An existing check needs a name."));
                }
                required(&check.expression, "Each check's expression")?;
            }
            Ok(())
        }
        TypeKind::Range => required(&definition.base_type, "The subtype"),
    }
}

fn check_sql(check: &DomainCheck) -> String {
    if check.name.is_empty() {
        return format!("CHECK ({})", check.expression);
    }
    format!("CONSTRAINT {} CHECK ({})", ident(&check.name), check.expression)
}

fn attribute_sql(attribute: &TypeAttribute) -> String {
    format!("{} {}", ident(&attribute.name), attribute.data_type)
}

/// The statement that creates the type.
pub fn create_statement(definition: &TypeDefinition) -> String {
    let target = qualified(&definition.schema, &definition.name);
    match definition.kind {
        TypeKind::Enum => {
            let labels: Vec<String> = definition.values.iter().map(|value| literal(&value.label)).collect();
            format!("CREATE TYPE {target} AS ENUM ({})", labels.join(", "))
        }
        TypeKind::Composite => {
            let attributes: Vec<String> = definition.attributes.iter().map(attribute_sql).collect();
            format!("CREATE TYPE {target} AS (\n  {}\n)", attributes.join(",\n  "))
        }
        TypeKind::Domain => {
            let mut parts = vec![format!("CREATE DOMAIN {target} AS {}", definition.base_type)];
            if !definition.default.is_empty() {
                parts.push(format!("DEFAULT {}", definition.default));
            }
            if definition.not_null {
                parts.push("NOT NULL".into());
            }
            parts.extend(definition.checks.iter().map(check_sql));
            parts.join("\n  ")
        }
        TypeKind::Range => format!("CREATE TYPE {target} AS RANGE (SUBTYPE = {})", definition.base_type),
    }
}

/// `ALTER TYPE … RENAME VALUE` and `ADD VALUE` statements. Postgres can't drop or reorder an enum's values.
fn alter_enum(before: &TypeDefinition, after: &TypeDefinition, target: &str) -> Result<Vec<String>, CommandError> {
    let kept: Vec<&str> = after.values.iter().filter_map(|value| value.original.as_deref()).collect();
    let existing: Vec<&str> = before.values.iter().map(|value| value.label.as_str()).collect();
    if existing.iter().any(|label| !kept.contains(label)) {
        return Err(invalid("Postgres can't remove a value from an enum. Recreate the type to drop one."));
    }
    if kept != existing {
        return Err(invalid("Postgres can't reorder an enum's existing values."));
    }
    let mut statements = Vec::new();
    for value in after.values.iter().filter(|value| value.original.as_ref().is_some_and(|original| *original != value.label)) {
        statements.push(format!("ALTER TYPE {target} RENAME VALUE {} TO {}", literal(value.original.as_deref().unwrap_or_default()), literal(&value.label)));
    }
    for (index, value) in after.values.iter().enumerate().filter(|(_, value)| value.original.is_none()) {
        let place = match (index.checked_sub(1).and_then(|before| after.values.get(before)), after.values.get(index + 1)) {
            (Some(previous), _) => format!(" AFTER {}", literal(&previous.label)),
            (None, Some(next)) => format!(" BEFORE {}", literal(&next.label)),
            (None, None) => String::new(),
        };
        statements.push(format!("ALTER TYPE {target} ADD VALUE {}{place}", literal(&value.label)));
    }
    Ok(statements)
}

fn alter_composite(before: &TypeDefinition, after: &TypeDefinition, target: &str, options: ChangeOptions) -> Vec<String> {
    let cascade = if options.cascade { " CASCADE" } else { "" };
    let mut statements = Vec::new();
    let mut actions = Vec::new();
    for original in &before.attributes {
        if !after.attributes.iter().any(|attribute| attribute.original_name.as_deref() == Some(&original.name)) {
            actions.push(format!("DROP ATTRIBUTE {}{cascade}", ident(&original.name)));
        }
    }
    for attribute in &after.attributes {
        let original = before.attributes.iter().find(|original| attribute.original_name.as_deref() == Some(&original.name));
        match original {
            None => actions.push(format!("ADD ATTRIBUTE {}{cascade}", attribute_sql(attribute))),
            Some(original) => {
                if original.name != attribute.name {
                    statements.push(format!("ALTER TYPE {target} RENAME ATTRIBUTE {} TO {}{cascade}", ident(&original.name), ident(&attribute.name)));
                }
                if original.data_type != attribute.data_type {
                    actions.push(format!("ALTER ATTRIBUTE {} TYPE {}{cascade}", ident(&attribute.name), attribute.data_type));
                }
            }
        }
    }
    if !actions.is_empty() {
        statements.push(format!("ALTER TYPE {target}\n  {}", actions.join(",\n  ")));
    }
    statements
}

fn alter_domain(before: &TypeDefinition, after: &TypeDefinition, target: &str, planned: &mut Planned) {
    let statements = &mut planned.statements;
    if before.default != after.default {
        statements.push(if after.default.is_empty() {
            format!("ALTER DOMAIN {target} DROP DEFAULT")
        } else {
            format!("ALTER DOMAIN {target} SET DEFAULT {}", after.default)
        });
    }
    let mut checked = Vec::new();
    if before.not_null != after.not_null {
        statements.push(format!("ALTER DOMAIN {target} {} NOT NULL", if after.not_null { "SET" } else { "DROP" }));
        if after.not_null {
            checked.push("NOT NULL".to_string());
        }
    }
    for original in &before.checks {
        let kept = after.checks.iter().find(|check| check.original_name.as_deref() == Some(&original.name));
        match kept {
            Some(check) if check.expression == original.expression => {
                if check.name != original.name {
                    statements.push(format!("ALTER DOMAIN {target} RENAME CONSTRAINT {} TO {}", ident(&original.name), ident(&check.name)));
                }
            }
            _ => statements.push(format!("ALTER DOMAIN {target} DROP CONSTRAINT {}", ident(&original.name))),
        }
    }
    for check in &after.checks {
        let original = before.checks.iter().find(|original| check.original_name.as_deref() == Some(&original.name));
        if original.is_none_or(|original| original.expression != check.expression) {
            statements.push(format!("ALTER DOMAIN {target} ADD {}", check_sql(check)));
            checked.push(if check.name.is_empty() { "the new check".to_string() } else { check.name.clone() });
        }
    }
    if !checked.is_empty() {
        planned.warnings.push(warning(
            "Checks every stored value",
            format!("Adding {} checks every column of this type in every table, and fails if a value doesn't pass.", checked.join(", ")),
        ));
    }
}

/// The DDL that changes `before` into `after`, except a new name, schema or comment, which the caller adds.
pub fn alter(before: &TypeDefinition, after: &TypeDefinition, options: ChangeOptions) -> Result<Planned, CommandError> {
    if before.kind != after.kind {
        return Err(invalid("A type can't change kind. Drop it and create the new one."));
    }
    if before.kind == TypeKind::Domain && before.base_type != after.base_type {
        return Err(invalid("A domain's base type can't change. Drop it and create the new one."));
    }
    if before.kind == TypeKind::Range && before.base_type != after.base_type {
        return Err(invalid("A range's subtype can't change. Drop it and create the new one."));
    }
    let target = qualified(&before.schema, &before.name);
    let mut planned = Planned::default();
    match before.kind {
        TypeKind::Enum => planned.statements = alter_enum(before, after, &target)?,
        TypeKind::Composite => planned.statements = alter_composite(before, after, &target, options),
        TypeKind::Domain => alter_domain(before, after, &target, &mut planned),
        TypeKind::Range => {}
    }
    Ok(planned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::objects::model::EnumValue;

    fn blank(kind: TypeKind) -> TypeDefinition {
        TypeDefinition {
            schema: "public".into(),
            name: "mood".into(),
            comment: None,
            kind,
            values: Vec::new(),
            attributes: Vec::new(),
            base_type: String::new(),
            default: String::new(),
            not_null: false,
            checks: Vec::new(),
        }
    }

    fn value(original: Option<&str>, label: &str) -> EnumValue {
        EnumValue { original: original.map(str::to_string), label: label.into() }
    }

    fn attribute(original_name: Option<&str>, name: &str, data_type: &str) -> TypeAttribute {
        TypeAttribute { original_name: original_name.map(str::to_string), name: name.into(), data_type: data_type.into() }
    }

    fn check(original_name: Option<&str>, name: &str, expression: &str) -> DomainCheck {
        DomainCheck { original_name: original_name.map(str::to_string), name: name.into(), expression: expression.into() }
    }

    fn mood() -> TypeDefinition {
        TypeDefinition { values: vec![value(Some("sad"), "sad"), value(Some("ok"), "ok")], ..blank(TypeKind::Enum) }
    }

    fn address() -> TypeDefinition {
        TypeDefinition {
            name: "address".into(),
            attributes: vec![attribute(Some("street"), "street", "text"), attribute(Some("zip"), "zip", "text")],
            ..blank(TypeKind::Composite)
        }
    }

    fn quantity() -> TypeDefinition {
        TypeDefinition {
            name: "quantity".into(),
            base_type: "integer".into(),
            default: "1".into(),
            checks: vec![check(Some("positive"), "positive", "VALUE > 0"), check(Some("small"), "small", "VALUE < 100")],
            ..blank(TypeKind::Domain)
        }
    }

    fn options() -> ChangeOptions {
        ChangeOptions { cascade: false, with_data: true, force: false }
    }

    fn refused(before: &TypeDefinition, after: &TypeDefinition) -> String {
        alter(before, after, options()).unwrap_err().to_string()
    }

    #[test]
    fn each_kind_is_created_with_its_own_statement() {
        let range = TypeDefinition { name: "span".into(), base_type: "numeric".into(), ..blank(TypeKind::Range) };
        let bare = TypeDefinition { default: String::new(), checks: Vec::new(), ..quantity() };
        assert_eq!(create_statement(&bare), "CREATE DOMAIN public.quantity AS integer");
        let mut domain = quantity();
        domain.not_null = true;
        domain.checks[1].name.clear();
        assert_eq!([create_statement(&mood()), create_statement(&address()), create_statement(&domain), create_statement(&range)], [
            "CREATE TYPE public.mood AS ENUM ('sad', 'ok')",
            "CREATE TYPE public.address AS (\n  street text,\n  zip text\n)",
            "CREATE DOMAIN public.quantity AS integer\n  DEFAULT 1\n  NOT NULL\n  CONSTRAINT positive CHECK (VALUE > 0)\n  CHECK (VALUE < 100)",
            "CREATE TYPE public.span AS RANGE (SUBTYPE = numeric)",
        ]);
    }

    #[test]
    fn validation_names_what_is_missing_or_repeated() {
        let errors: Vec<String> = [
            TypeDefinition { schema: String::new(), ..mood() },
            TypeDefinition { name: String::new(), ..mood() },
            TypeDefinition { values: vec![value(None, "")], ..mood() },
            TypeDefinition { values: vec![value(None, "a"), value(None, "a")], ..mood() },
            TypeDefinition { attributes: vec![attribute(None, "", "text")], ..address() },
            TypeDefinition { attributes: vec![attribute(None, "a", "")], ..address() },
            TypeDefinition { attributes: vec![attribute(None, "a", "text"), attribute(None, "a", "int")], ..address() },
            TypeDefinition { base_type: String::new(), ..quantity() },
            TypeDefinition { checks: vec![check(Some("old"), " ", "VALUE > 0")], ..quantity() },
            TypeDefinition { checks: vec![check(None, "", "")], ..quantity() },
            blank(TypeKind::Range),
        ]
        .iter()
        .map(|definition| validate(definition).unwrap_err().to_string())
        .collect();

        assert_eq!(errors, [
            "Schema is required.",
            "Name is required.",
            "Each value needs a label.",
            "Two values are labelled a.",
            "Each attribute's name is required.",
            "Each attribute's type is required.",
            "Two attributes are named a.",
            "The base type is required.",
            "An existing check needs a name.",
            "Each check's expression is required.",
            "The subtype is required.",
        ]);
        assert_eq!([validate(&mood()), validate(&address()), validate(&quantity())], [Ok(()), Ok(()), Ok(())]);
    }

    #[test]
    fn enum_values_are_renamed_then_added_beside_their_neighbours() {
        let after = TypeDefinition {
            values: vec![value(None, "awful"), value(Some("sad"), "glum"), value(None, "meh"), value(Some("ok"), "ok"), value(None, "great")],
            ..mood()
        };
        let empty = TypeDefinition { values: Vec::new(), ..mood() };

        assert_eq!(alter(&mood(), &after, options()).unwrap().statements, [
            "ALTER TYPE public.mood RENAME VALUE 'sad' TO 'glum'",
            "ALTER TYPE public.mood ADD VALUE 'awful' BEFORE 'glum'",
            "ALTER TYPE public.mood ADD VALUE 'meh' AFTER 'glum'",
            "ALTER TYPE public.mood ADD VALUE 'great' AFTER 'ok'",
        ]);
        assert_eq!(alter(&empty, &TypeDefinition { values: vec![value(None, "first")], ..mood() }, options()).unwrap().statements, [
            "ALTER TYPE public.mood ADD VALUE 'first'"
        ]);
    }

    #[test]
    fn enum_values_cannot_be_removed_or_reordered() {
        assert_eq!(
            refused(&mood(), &TypeDefinition { values: vec![value(Some("sad"), "sad")], ..mood() }),
            "Postgres can't remove a value from an enum. Recreate the type to drop one."
        );
        assert_eq!(
            refused(&mood(), &TypeDefinition { values: vec![value(Some("ok"), "ok"), value(Some("sad"), "sad")], ..mood() }),
            "Postgres can't reorder an enum's existing values."
        );
    }

    #[test]
    fn composite_attributes_are_renamed_then_dropped_added_and_retyped_together() {
        let after = TypeDefinition { attributes: vec![attribute(Some("street"), "line_1", "varchar(200)"), attribute(None, "city", "text")], ..address() };
        let cascaded = alter(&address(), &after, ChangeOptions { cascade: true, ..options() }).unwrap();

        assert_eq!(cascaded.statements, [
            "ALTER TYPE public.address RENAME ATTRIBUTE street TO line_1 CASCADE",
            "ALTER TYPE public.address\n  DROP ATTRIBUTE zip CASCADE,\n  ALTER ATTRIBUTE line_1 TYPE varchar(200) CASCADE,\n  ADD ATTRIBUTE city text CASCADE",
        ]);
        assert_eq!(alter(&address(), &address(), options()).unwrap(), Planned::default());
    }

    #[test]
    fn domain_defaults_null_rules_and_checks_change_one_statement_at_a_time() {
        let after = TypeDefinition {
            default: String::new(),
            not_null: true,
            checks: vec![check(Some("positive"), "above_zero", "VALUE > 0"), check(Some("small"), "small", "VALUE < 50"), check(None, "", "VALUE <> 13")],
            ..quantity()
        };
        let loosened = TypeDefinition { default: "2".into(), checks: Vec::new(), ..quantity() };
        let mut strict = quantity();
        strict.not_null = true;

        let planned = alter(&quantity(), &after, options()).unwrap();

        assert_eq!(planned.statements, [
            "ALTER DOMAIN public.quantity DROP DEFAULT",
            "ALTER DOMAIN public.quantity SET NOT NULL",
            "ALTER DOMAIN public.quantity RENAME CONSTRAINT positive TO above_zero",
            "ALTER DOMAIN public.quantity DROP CONSTRAINT small",
            "ALTER DOMAIN public.quantity ADD CONSTRAINT small CHECK (VALUE < 50)",
            "ALTER DOMAIN public.quantity ADD CHECK (VALUE <> 13)",
        ]);
        assert_eq!(
            planned.warnings[0].detail,
            "Adding NOT NULL, small, the new check checks every column of this type in every table, and fails if a value doesn't pass."
        );
        assert_eq!(alter(&quantity(), &loosened, options()).unwrap().statements, [
            "ALTER DOMAIN public.quantity SET DEFAULT 2",
            "ALTER DOMAIN public.quantity DROP CONSTRAINT positive",
            "ALTER DOMAIN public.quantity DROP CONSTRAINT small",
        ]);
        assert_eq!(alter(&strict, &quantity(), options()).unwrap().statements, ["ALTER DOMAIN public.quantity DROP NOT NULL"]);
    }

    #[test]
    fn a_type_keeps_its_kind_and_a_domain_or_range_its_underlying_type() {
        let range = TypeDefinition { base_type: "numeric".into(), ..blank(TypeKind::Range) };
        assert_eq!(refused(&mood(), &address()), "A type can't change kind. Drop it and create the new one.");
        assert_eq!(
            refused(&quantity(), &TypeDefinition { base_type: "bigint".into(), ..quantity() }),
            "A domain's base type can't change. Drop it and create the new one."
        );
        assert_eq!(
            refused(&range, &TypeDefinition { base_type: "integer".into(), ..range.clone() }),
            "A range's subtype can't change. Drop it and create the new one."
        );
        assert_eq!(alter(&range, &range, options()).unwrap(), Planned::default());
    }
}
