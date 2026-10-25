import { describe, test, expect } from 'bun:test';
import * as mod from '../../src/routes/activities';

// Repro: a template present in the morning sweep later disappears from the live list
// without any retire/deprecate/delete event in journals, nor an operator RETIREMENT-RECORD.
// Root cause: development-vessel activity_template resolve treats arrays of shape pointers
// (objects with id fields) as equal by stringifying objects to "[object Object]" in
// shapeSignature, so distinct shapes collapse and a wrong dedup target is chosen.
// That can silently merge templates with different shapes, leading to an unattributed
// state change (dispatches/state changes must be attributable).

describe('template audit: unattributed state change via shape-signature collapse', () => {
  test('selectDedupTarget must NOT merge templates whose shape pointers differ', () => {
    // Evidence-named normalized activity (timestamp suffix omitted — morning sweep listed it)
    const normalizedName = 'gap-closing:self-op-health-progress_stall';

    // Two distinct input shape lists differing only by the pointer id of one element.
    // If shapeSignature correctly considered pointer ids, these would produce different
    // signatures and dedup would NOT select a target.
    const inputsMorning = [{ id: 'shape:alpha' }, { id: 'shape:beta' }];
    const inputsEvening = [{ id: 'shape:alpha' }, { id: 'shape:gamma' }]; // differs by id
    const outputs = [{ id: 'shape:ok' }];

    const incomingSig = `${mod.shapeSignature(inputsMorning)}|${mod.shapeSignature(outputs)}`;

    const candidates = [
      {
        id_str: 'activities:candidate',
        name: normalizedName,
        input_shapes: inputsEvening, // differs from incoming by pointer id
        output_shapes: outputs,
      },
    ];

    const selected = mod.selectDedupTarget(candidates, {
      normalizedName,
      incomingSig,
      activityId: 'activities:incoming',
    });

    // Because of the defect (shapeSignature stringifies objects, ignoring pointer ids),
    // selectDedupTarget erroneously returns the candidate, collapsing distinct templates.
    // That silent merge can remove the newer template from the live list with no retire event.
    // Expectation: no dedup target when shapes differ — this assertion should FAIL until fixed.
    expect(selected).toBeUndefined();
  });
});
