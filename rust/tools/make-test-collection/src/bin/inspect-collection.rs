//! Ad-hoc diagnostic (NOT part of the wasm build): opens an arbitrary
//! real-world `.anki2`/`.anki21` file natively (fast iteration, full
//! println/debug access, no wasm/emcc layer to obscure anything) and reports
//! exactly what `get_next_card`/`get_queued_cards` see. Written to debug why
//! a real 7500-note/15000-card collection (a downloaded AnkiWeb shared deck,
//! schedVer 2, all cards fresh/new, deck new-per-day limit 20) came back with
//! an empty queue through the wasm bridge — see docs/ARCHITECTURE.md.

use anki::collection::CollectionBuilder;
use anki::prelude::DeckId;
use anki::prelude::I18n;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect(
        "usage: inspect-collection <path-to-collection.anki2> [select-deck-id]",
    );
    let select_deck_id: Option<i64> = args.next().map(|s| s.parse().expect("deck id must be an integer"));

    // CollectionBuilder/SQLite want to write-lock the file (WAL etc.); work
    // on a throwaway copy so the original fixture is never mutated.
    let tmp = format!("{path}.inspect-tmp");
    std::fs::copy(&path, &tmp).expect("failed to copy fixture to a scratch path");

    let tr = I18n::new(&["en"]);
    let mut col = CollectionBuilder::new(&tmp)
        .set_tr(tr)
        .set_server(false)
        .build()
        .expect("failed to open collection");
    println!("opened ok");

    if let Some(id) = select_deck_id {
        col.set_current_deck(DeckId(id))
            .expect("failed to set current deck");
        println!("set current deck -> {id}");
    }

    match col.get_next_card() {
        Ok(Some(qc)) => println!("get_next_card -> Some(card id={:?}, kind={:?})", qc.card.id(), qc.kind),
        Ok(None) => println!("get_next_card -> None (empty queue)"),
        Err(e) => println!("get_next_card -> Err({e:?})"),
    }

    match col.get_queued_cards(50, false) {
        Ok(qc) => println!(
            "get_queued_cards(50, false) -> new_count={} learning_count={} review_count={} cards.len()={}",
            qc.new_count, qc.learning_count, qc.review_count, qc.cards.len()
        ),
        Err(e) => println!("get_queued_cards -> Err({e:?})"),
    }

    std::fs::remove_file(&tmp).ok();
}
