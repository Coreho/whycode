// Rust constructs where misplaced comments must be caught or safely retained.
#![allow(dead_code)]
//! Inner line documentation.
/*! Inner block documentation. */

const NORMAL: &str = "normal begins
normal continues
normal ends";
const CONTINUED: &str = "continued begins \
    continued resumes
continued ends";
const RAW: &str = r#"raw begins
raw continues with "quotes" and // text
raw ends"#;
const BYTES: &[u8] = b"bytes begin
bytes continue
bytes end";

/// Keeps the first doc line.
/// Keeps the second doc line.
/** Outer block documentation. */
#[derive(Debug)]
pub struct Record<'a> {
    name: &'a str,
}

/* outer /* inner */ still comment */
macro_rules! double {
    ($value:expr) => {
        $value * 2
    };
}

pub fn calculate(record: &Record<'_>, value: i32) -> i32 {
    let values = vec![
        value,
        2,
    ];
    let brace = '{';
    let quote = '"';
    match (brace, quote, record.name) {
        ('{', '"', "Ada") => {
            double!(values[0])
        }
        _ => {
            values[1]
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn checks_calculation() {
        assert_eq!(super::calculate(&super::Record { name: "Ada" }, 3), 6);
    }
}
