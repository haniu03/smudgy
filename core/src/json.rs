use serde_json::Value;

/// Recursive JSON merge: objects compose per key; every other incoming value
/// replaces the value below it.
pub(crate) fn deep_merge(base: &mut Value, higher: Value) {
    match (base, higher) {
        (Value::Object(base), Value::Object(higher)) => {
            for (key, value) in higher {
                if let Some(existing) = base.get_mut(&key) {
                    deep_merge(existing, value);
                } else {
                    base.insert(key, value);
                }
            }
        }
        (base, higher) => *base = higher,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::deep_merge;

    #[test]
    fn objects_merge_recursively_and_scalars_replace() {
        let mut base = json!({"a": {"b": 1, "c": 2}, "d": 3});
        deep_merge(&mut base, json!({"a": {"b": 4}, "d": [5]}));
        assert_eq!(base, json!({"a": {"b": 4, "c": 2}, "d": [5]}));
    }
}
