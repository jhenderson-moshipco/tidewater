//! Writes the DDL for databases and extensions. Nothing here touches a database.

use super::ddl::{Planned, ident, literal, required};
use super::model::{ChangeOptions, DatabaseDefinition, ExtensionDefinition};
use crate::error::CommandError;

fn invalid(message: &str) -> CommandError {
    CommandError::Invalid(message.to_string())
}

pub fn validate_database(database: &DatabaseDefinition) -> Result<(), CommandError> {
    required(&database.name, "Name")?;
    if database.connection_limit < -1 {
        return Err(invalid("The connection limit is a number of sessions, or -1 for no limit."));
    }
    Ok(())
}

pub fn validate_extension(extension: &ExtensionDefinition) -> Result<(), CommandError> {
    required(&extension.name, "The extension")
}

/// `CREATE DATABASE` with each setting that isn't left to the template.
pub fn create_database(database: &DatabaseDefinition) -> String {
    let mut sql = format!("CREATE DATABASE {}", ident(&database.name));
    if !database.owner.is_empty() {
        sql.push_str(&format!(" OWNER {}", ident(&database.owner)));
    }
    if !database.template.is_empty() {
        sql.push_str(&format!(" TEMPLATE {}", ident(&database.template)));
    }
    for (keyword, value) in [("ENCODING", &database.encoding), ("LC_COLLATE", &database.collation), ("LC_CTYPE", &database.ctype)] {
        if !value.is_empty() {
            sql.push_str(&format!(" {keyword} {}", literal(value)));
        }
    }
    if database.connection_limit != -1 {
        sql.push_str(&format!(" CONNECTION LIMIT {}", database.connection_limit));
    }
    sql
}

pub fn create_extension(extension: &ExtensionDefinition, options: ChangeOptions) -> String {
    let mut sql = format!("CREATE EXTENSION {}", ident(&extension.name));
    if !extension.schema.is_empty() {
        sql.push_str(&format!(" WITH SCHEMA {}", ident(&extension.schema)));
    }
    if !extension.version.is_empty() {
        sql.push_str(&format!(" VERSION {}", literal(&extension.version)));
    }
    if options.cascade {
        sql.push_str(" CASCADE");
    }
    sql
}

/// The DDL for a new owner or connection limit; a new name and comment are the caller's. The rest is fixed.
pub fn alter_database(before: &DatabaseDefinition, after: &DatabaseDefinition) -> Result<Planned, CommandError> {
    let fixed = |database: &DatabaseDefinition| (database.encoding.clone(), database.template.clone(), database.collation.clone(), database.ctype.clone());
    if fixed(before) != fixed(after) {
        return Err(invalid("A database's encoding, template and locale are set when it is created and can't change."));
    }
    let target = ident(&before.name);
    let mut planned = Planned::default();
    if before.owner != after.owner {
        planned.statements.push(format!("ALTER DATABASE {target} OWNER TO {}", ident(&after.owner)));
    }
    if before.connection_limit != after.connection_limit {
        planned.statements.push(format!("ALTER DATABASE {target} WITH CONNECTION LIMIT {}", after.connection_limit));
    }
    if before.name != after.name {
        planned.closes_database = Some(before.name.clone());
    }
    Ok(planned)
}

/// The DDL for a new version or schema. An extension's name is its identity.
pub fn alter_extension(before: &ExtensionDefinition, after: &ExtensionDefinition) -> Result<Planned, CommandError> {
    if before.name != after.name {
        return Err(invalid("An extension can't be renamed."));
    }
    let target = ident(&before.name);
    let mut planned = Planned::default();
    if before.version != after.version {
        planned.statements.push(format!("ALTER EXTENSION {target} UPDATE TO {}", literal(&after.version)));
    }
    if before.schema != after.schema {
        planned.statements.push(format!("ALTER EXTENSION {target} SET SCHEMA {}", ident(&after.schema)));
    }
    Ok(planned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orders() -> DatabaseDefinition {
        DatabaseDefinition {
            name: "orders".into(),
            owner: String::new(),
            encoding: String::new(),
            template: String::new(),
            collation: String::new(),
            ctype: String::new(),
            connection_limit: -1,
            comment: None,
        }
    }

    fn citext() -> ExtensionDefinition {
        ExtensionDefinition { name: "citext".into(), schema: String::new(), version: String::new(), comment: None }
    }

    fn options(cascade: bool) -> ChangeOptions {
        ChangeOptions { cascade, with_data: true, force: false }
    }

    #[test]
    fn a_database_is_created_with_only_the_settings_given() {
        let full = DatabaseDefinition {
            owner: "app".into(),
            template: "template0".into(),
            encoding: "UTF8".into(),
            collation: "en_US.UTF-8".into(),
            ctype: "C".into(),
            connection_limit: 20,
            ..orders()
        };
        assert_eq!([create_database(&orders()), create_database(&full)], [
            "CREATE DATABASE orders",
            "CREATE DATABASE orders OWNER app TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'C' CONNECTION LIMIT 20",
        ]);
    }

    #[test]
    fn a_database_changes_owner_and_limit_but_not_its_encoding_template_or_locale() {
        let after = DatabaseDefinition { name: "shop".into(), owner: "app".into(), connection_limit: 5, ..orders() };
        let planned = alter_database(&orders(), &after).unwrap();

        assert_eq!(planned.statements, ["ALTER DATABASE orders OWNER TO app", "ALTER DATABASE orders WITH CONNECTION LIMIT 5"]);
        assert_eq!(planned.closes_database.as_deref(), Some("orders"));
        assert_eq!(alter_database(&orders(), &orders()).unwrap(), Planned::default());
        assert_eq!(
            alter_database(&orders(), &DatabaseDefinition { encoding: "LATIN1".into(), ..orders() }).unwrap_err().to_string(),
            "A database's encoding, template and locale are set when it is created and can't change."
        );
    }

    #[test]
    fn database_and_extension_validation() {
        assert_eq!(validate_database(&DatabaseDefinition { name: String::new(), ..orders() }).unwrap_err().to_string(), "Name is required.");
        assert_eq!(
            validate_database(&DatabaseDefinition { connection_limit: -2, ..orders() }).unwrap_err().to_string(),
            "The connection limit is a number of sessions, or -1 for no limit."
        );
        assert_eq!(validate_database(&orders()), Ok(()));
        assert_eq!(validate_extension(&ExtensionDefinition { name: String::new(), ..citext() }).unwrap_err().to_string(), "The extension is required.");
        assert_eq!(validate_extension(&citext()), Ok(()));
    }

    #[test]
    fn an_extension_is_created_in_a_schema_at_a_version_with_what_it_needs_and_updated_or_moved_but_not_renamed() {
        let placed = ExtensionDefinition { schema: "ext".into(), version: "1.6".into(), ..citext() };
        assert_eq!([create_extension(&citext(), options(false)), create_extension(&placed, options(true))], [
            "CREATE EXTENSION citext",
            "CREATE EXTENSION citext WITH SCHEMA ext VERSION '1.6' CASCADE",
        ]);
        assert_eq!(alter_extension(&citext(), &placed).unwrap().statements, [
            "ALTER EXTENSION citext UPDATE TO '1.6'",
            "ALTER EXTENSION citext SET SCHEMA ext"
        ]);
        assert_eq!(alter_extension(&citext(), &citext()).unwrap(), Planned::default());
        assert_eq!(
            alter_extension(&citext(), &ExtensionDefinition { name: "hstore".into(), ..citext() }).unwrap_err().to_string(),
            "An extension can't be renamed."
        );
    }
}
