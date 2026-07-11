//! Host-native helper (NOT part of the wasm build): produces a fresh, valid,
//! empty `.anki2` SQLite collection file, so the wasm bridge's Node smoke
//! test has a real collection to feed into `wasm_open_collection` without
//! needing an external fixture. See docs/ARCHITECTURE.md (2026-07-10 §7).
//!
//! `CollectionBuilder::new(path).build()` creates a fresh schema when `path`
//! doesn't exist yet (via `SqliteStorage::open_or_create`), so we just need
//! to point it at a nonexistent path, then close the collection cleanly so
//! SQLite flushes everything to disk.

use anki::collection::CollectionBuilder;
use anki::prelude::DeckId;
use anki::prelude::I18n;
use anki::storage::SchemaVersion;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect(
        "usage: make-test-collection <output-path.anki2> [--with-note|--with-nested-decks] \
         (path must not already exist)",
    );
    let flag = args.next();
    let with_note = flag.as_deref() == Some("--with-note");
    let with_nested_decks = flag.as_deref() == Some("--with-nested-decks");

    if std::path::Path::new(&path).exists() {
        eprintln!("refusing to overwrite existing file: {path}");
        std::process::exit(1);
    }

    let tr = I18n::new(&["en"]);
    let mut col = CollectionBuilder::new(&path)
        .set_tr(tr)
        .set_server(false)
        .build()
        .expect("failed to build a fresh collection");

    if with_note {
        // Every fresh collection ships the stock "Basic" notetype and a
        // default deck (id 1); add one real note to it so the resulting file
        // has a due card for the scheduler to actually return.
        let notetype = col
            .get_notetype_by_name("Basic")
            .expect("query failed")
            .expect("stock 'Basic' notetype missing from fresh collection");
        let mut note = notetype.new_note();
        note.set_field(0, "smoke-test front").unwrap();
        note.set_field(1, "smoke-test back").unwrap();
        col.add_note(&mut note, DeckId(1))
            .expect("failed to add note");
    }

    if with_nested_decks {
        // Ad-hoc fixture for verifying web/src/ui/ImportView/DeckTree.tsx:
        // rslib auto-creates missing parent decks (Collection::add_or_update_deck
        // -> match_or_create_parents), so creating the deepest deck alone is
        // enough to produce the whole "Ankizin::M1_Vorklinik::Anatomie" chain
        // plus a sibling, matching the real-world case that prompted this
        // (a 57-entry flat deck list that should have rendered as a tree).
        let deepest = col
            .get_or_create_normal_deck("Ankizin::M1_Vorklinik::Anatomie")
            .expect("failed to create nested deck");
        col.get_or_create_normal_deck("Ankizin::M1_Vorklinik::Physiologie")
            .expect("failed to create sibling deck");
        col.get_or_create_normal_deck("Ankizin::M2_Klinik")
            .expect("failed to create second top-level branch");

        let notetype = col
            .get_notetype_by_name("Basic")
            .expect("query failed")
            .expect("stock 'Basic' notetype missing from fresh collection");
        let mut note = notetype.new_note();
        note.set_field(0, "nested-deck test front").unwrap();
        note.set_field(1, "nested-deck test back").unwrap();
        col.add_note(&mut note, deepest.id)
            .expect("failed to add note");
    }

    col.close(Some(SchemaVersion::V18))
        .expect("failed to close collection");

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    println!(
        "wrote {path} ({size} bytes, with_note={with_note}, with_nested_decks={with_nested_decks})"
    );
}
