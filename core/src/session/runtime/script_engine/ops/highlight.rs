//! Native shader batches and transactional rich-fragment callback highlights.
use super::{
    ActionQueue, Arc, LineOperation, OpState, Rc, RefCell, RuntimeAction, StyledLine,
    StyledTextOpError, Weak, WidgetShadersEnabled, WidgetsEnabled, ensure, ensure_current_line,
    grants, op2, queue_own_action, ring_line, take_inline_content, v8,
};
use smudgy_session_model::inline_content::{InlineContent, InlineContentExchange};
use smudgy_session_model::line_operation::RichHighlight;
use std::ops::Range;

/// No V8 references: the JS callback and its elements stay in JS, while this
/// short-lived batch keeps source links and validated native content alive.
pub(super) struct HighlightBatch(RefCell<Option<Batch>>);
struct Batch {
    line_number: Option<u32>,
    source: Option<Arc<StyledLine>>,
    snapshot: Arc<StyledLine>,
    pending_count: usize,
    ranges: Vec<Range<usize>>,
    current: Option<Arc<InlineContent>>,
    results: Vec<RichHighlight>,
}
unsafe impl deno_core::cppgc::GarbageCollected for HighlightBatch {
    fn get_name(&self) -> &'static std::ffi::CStr {
        c"SmudgyHighlightBatch"
    }
    fn trace(&self, _visitor: &mut v8::cppgc::Visitor) {}
}

fn invalid(message: &str) -> StyledTextOpError {
    StyledTextOpError::Invalid(message.into())
}

fn source_line(
    state: &OpState,
    number: Option<u32>,
) -> Result<Option<Arc<StyledLine>>, StyledTextOpError> {
    if let Some(number) = number {
        return Ok(ring_line(state, number as usize));
    }
    ensure_current_line(state)?;
    Ok(state
        .borrow::<Rc<RefCell<Weak<StyledLine>>>>()
        .borrow()
        .upgrade())
}

fn pending_operations(state: &OpState, number: Option<u32>) -> Vec<LineOperation> {
    if let Some(number) = number {
        state
            .borrow::<ActionQueue>()
            .borrow()
            .line_operations(number as usize)
            .cloned()
            .collect()
    } else {
        state
            .borrow::<Rc<RefCell<Vec<LineOperation>>>>()
            .borrow()
            .clone()
    }
}

fn pending_count(state: &OpState, number: Option<u32>) -> usize {
    if let Some(number) = number {
        state
            .borrow::<ActionQueue>()
            .borrow()
            .line_operations(number as usize)
            .count()
    } else {
        state
            .borrow::<Rc<RefCell<Vec<LineOperation>>>>()
            .borrow()
            .len()
    }
}

#[op2]
#[cppgc]
#[allow(clippy::needless_pass_by_value)] // Optional op strings must be owned.
pub(super) fn op_smudgy_highlight_begin(
    state: &mut OpState,
    line_number: Option<u32>,
    #[string] needle: Option<String>,
    begin: u32,
    end: u32,
) -> Result<HighlightBatch, StyledTextOpError> {
    prepare_batch(state, line_number, needle.as_deref(), begin, end)
        .map(|batch| HighlightBatch(RefCell::new(Some(batch))))
}

fn prepare_batch(
    state: &OpState,
    line_number: Option<u32>,
    needle: Option<&str>,
    begin: u32,
    end: u32,
) -> Result<Batch, StyledTextOpError> {
    ensure(grants(state).change_display, "change-display")?;
    let source = source_line(state, line_number)?;
    let operations = pending_operations(state, line_number);
    let snapshot = operations.iter().fold(
        source
            .clone()
            .unwrap_or_else(|| Arc::new(StyledLine::new("", Vec::new()))),
        |line, operation| operation.apply(&line),
    );
    let ranges = if source.is_none() {
        Vec::new()
    } else if let Some(needle) = needle {
        if needle.is_empty() {
            Vec::new()
        } else {
            snapshot
                .text
                .match_indices(needle)
                .map(|(begin, text)| begin..begin + text.len())
                .collect()
        }
    } else {
        let begin =
            smudgy_session_model::styled_line::floor_char_boundary(&snapshot.text, begin as usize);
        let end =
            smudgy_session_model::styled_line::floor_char_boundary(&snapshot.text, end as usize);
        (begin < end).then_some(begin..end).into_iter().collect()
    };
    Ok(Batch {
        line_number,
        source,
        snapshot,
        pending_count: operations.len(),
        current: None,
        ranges,
        results: Vec::new(),
    })
}

#[op2]
#[allow(clippy::needless_pass_by_value)] // Optional op strings must be owned.
pub(super) fn op_smudgy_highlight_shader(
    state: &mut OpState,
    line_number: Option<u32>,
    #[string] needle: Option<String>,
    begin: u32,
    end: u32,
    token: u32,
) -> Result<bool, StyledTextOpError> {
    let effect = state
        .borrow_mut::<InlineContentExchange>()
        .take_effect(token)
        .map_err(invalid)?;
    ensure(state.borrow::<WidgetsEnabled>().0, "widgets")?;
    ensure(state.borrow::<WidgetShadersEnabled>().0, "widgets:shaders")?;
    let batch = prepare_batch(state, line_number, needle.as_deref(), begin, end)?;
    if batch.ranges.is_empty() {
        return Ok(false);
    }
    // No fragment extraction: only embedded widgets need checking before the
    // entire batch commits. Styles, links and fonts remain on the original line.
    for object in batch
        .snapshot
        .objects
        .iter()
        .flat_map(|objects| objects.iter())
    {
        let index = batch
            .ranges
            .partition_point(|range| range.end <= object.range.start);
        if batch
            .ranges
            .get(index)
            .is_some_and(|range| range.start < object.range.end)
        {
            return Err(invalid("shader highlights cannot wrap embedded widgets"));
        }
    }
    queue_operation(
        state,
        line_number,
        LineOperation::HighlightShader {
            ranges: Arc::new(batch.ranges),
            effect: Arc::new(effect),
        },
    );
    Ok(true)
}

fn queue_operation(state: &mut OpState, line_number: Option<u32>, operation: LineOperation) {
    if let Some(line_number) = line_number {
        queue_own_action(
            state,
            RuntimeAction::PerformLineOperation {
                line_number: line_number as usize,
                operation: Box::new(operation),
            },
        );
    } else {
        state
            .borrow::<Rc<RefCell<Vec<LineOperation>>>>()
            .borrow_mut()
            .push(operation);
    }
}

#[op2]
pub(super) fn op_smudgy_highlight_next(
    state: &mut OpState,
    #[cppgc] batch: &HighlightBatch,
) -> Result<Option<u32>, StyledTextOpError> {
    let mut batch = batch.0.borrow_mut();
    let batch = batch
        .as_mut()
        .ok_or_else(|| invalid("highlight batch has finished"))?;
    if batch.current.is_some() {
        return Err(invalid("previous highlight result has not been staged"));
    }
    let Some(range) = batch.ranges.get(batch.results.len()) else {
        return Ok(None);
    };
    let content =
        Arc::new(InlineContent::from_line_range(&batch.snapshot, range.clone()).map_err(invalid)?);
    let token = state
        .borrow_mut::<InlineContentExchange>()
        .put(content.clone())
        .map_err(invalid)?;
    batch.current = Some(content);
    Ok(Some(token))
}

#[op2(fast)]
pub(super) fn op_smudgy_highlight_stage(
    state: &mut OpState,
    #[cppgc] batch: &HighlightBatch,
    token: u32,
) -> Result<(), StyledTextOpError> {
    let content = take_inline_content(state, token)?;
    let mut batch = batch.0.borrow_mut();
    let batch = batch
        .as_mut()
        .ok_or_else(|| invalid("highlight batch has finished"))?;
    let range = batch
        .ranges
        .get(batch.results.len())
        .ok_or_else(|| invalid("unexpected highlight result"))?;
    if !content.decorations.is_empty() {
        ensure(state.borrow::<WidgetsEnabled>().0, "widgets")?;
    }
    let original = batch
        .current
        .take()
        .ok_or_else(|| invalid("missing highlight source"))?;
    batch
        .results
        .push(RichHighlight::new(range.clone(), &original, content).map_err(invalid)?);
    Ok(())
}

#[op2(fast)]
pub(super) fn op_smudgy_highlight_finish(
    state: &mut OpState,
    #[cppgc] batch: &HighlightBatch,
    commit: bool,
) -> Result<bool, StyledTextOpError> {
    let batch = batch.0.borrow_mut().take();
    if !commit {
        return Ok(false);
    }
    let batch = batch.ok_or_else(|| invalid("highlight batch has finished"))?;
    ensure(grants(state).change_display, "change-display")?;
    let source = source_line(state, batch.line_number)?;
    let same_source = match (&batch.source, &source) {
        (Some(a), Some(b)) => Arc::ptr_eq(a, b),
        (None, None) => true,
        _ => false,
    };
    if !same_source || pending_count(state, batch.line_number) != batch.pending_count {
        return Err(invalid(
            "highlight callbacks must not edit their target line",
        ));
    }
    if batch.results.len() != batch.ranges.len() {
        return Err(invalid("incomplete highlight batch"));
    }
    let matched = !batch.ranges.is_empty();
    if matched {
        let operation = LineOperation::HighlightRich {
            highlights: Arc::new(batch.results),
        };
        queue_operation(state, batch.line_number, operation);
    }
    Ok(matched)
}
