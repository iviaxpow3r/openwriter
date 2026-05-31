import { useCallback, useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent } from 'react';

/**
 * Title fields read as single-line but must wrap long titles onto multiple
 * visible lines instead of clipping them off the right edge. A plain <input>
 * can never wrap, so title fields use a <textarea> wired with this hook.
 *
 * The hook keeps title semantics intact while adding wrapping:
 *   - auto-grows the textarea height to fit the wrapped text (reset to `auto`,
 *     then measure `scrollHeight`),
 *   - re-measures whenever the bound value changes externally (doc switch,
 *     agent rename, reload-from-disk),
 *   - Enter blurs the field instead of inserting a newline,
 *   - typed/pasted newlines are collapsed to a space so the saved title value
 *     never contains an embedded newline.
 *
 * Render a <textarea rows={1}> with the returned ref + handlers; the value and
 * className stay at the call site so each view keeps its own styling.
 */
export function useAutoGrowTitle(value: string, onChange: (next: string) => void) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // Re-measure after every render where the bound value changed, so external
  // updates (not just keystrokes) grow/shrink the field to fit.
  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value.replace(/[\r\n]+/g, ' '));
      resize();
    },
    [onChange, resize],
  );

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      // Title is single-line in spirit: Enter commits (blurs), never newlines.
      e.preventDefault();
      ref.current?.blur();
    }
  }, []);

  return { ref, onChange: handleChange, onKeyDown: handleKeyDown };
}
