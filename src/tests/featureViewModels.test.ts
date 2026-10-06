import { describe, expect, it } from 'vitest';
import { FieldsViewModel } from '../features/fields/fieldsViewModel';
import { RulesViewModel } from '../features/rules/rulesViewModel';
import { SamplesViewModel } from '../features/samples/samplesViewModel';
import type { BusinessRule, ConditionGroup } from '../models/ruleModel';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  async load() { return null; }
  async save() { return undefined; }
}

class FakeChecker {
  run() { return { promise: Promise.resolve({ checkedCases: 1, coveredCases: 1, coveragePercent: 100, overlaps: [], unreachableRuleIds: [], shadowedRuleIds: [], uncoveredExamples: [], truncated: false }), cancel() {} }; }
}

describe('feature ViewModels', () => {
  it('adds typed fields, builds a rule, protects referenced fields, and evaluates a sample', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const fields = new FieldsViewModel(workspace);
    const rules = new RulesViewModel(workspace);
    const samples = new SamplesViewModel(workspace);
    fields.addField('boolean');
    rules.addRule();
    const addedField = workspace.getSnapshot().project?.fields.at(-1);
    expect(addedField?.type).toBe('boolean');
    expect(fields.removeField('member-level')).toBe(false);
    expect(workspace.getSnapshot().notice).toContain('仍被');
    const project = workspace.getSnapshot().project;
    expect(project).toBeDefined();
    const boolField = project?.fields.at(-1);
    if (boolField) samples.setValue(boolField.id, true);
    samples.evaluate();
    expect(workspace.getSnapshot().sampleEvaluation?.valid).toBe(true);
    workspace.dispose();
  });

  it('edits nested condition groups and blocks meaningless structures', async () => {
    const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
    await workspace.start();
    const rules = new RulesViewModel(workspace);
    const currentRule = (ruleId: string) => workspace.getSnapshot().project?.rules.find((rule) => rule.id === ruleId) as BusinessRule;
    const ruleId = workspace.getSnapshot().project?.rules[0].id ?? '';

    rules.addConditionGroup(ruleId, []);
    let rule = currentRule(ruleId);
    const groupIndex = rule.conditions.conditions.length - 1;
    const subgroup = rule.conditions.conditions[groupIndex];
    expect(subgroup.kind).toBe('group');
    expect((subgroup as ConditionGroup).conditions).toHaveLength(2);

    rules.setGroupOperator(ruleId, [groupIndex], 'and');
    rules.changeConditionField(ruleId, [groupIndex, 0], 'coupon-active');
    rule = currentRule(ruleId);
    const updated = rule.conditions.conditions[groupIndex] as ConditionGroup;
    expect(updated.operator).toBe('and');
    expect(updated.conditions[0]).toMatchObject({ kind: 'predicate', fieldId: 'coupon-active' });
    expect(workspace.getSnapshot().sampleEvaluation?.valid).toBe(true);

    rules.removeCondition(ruleId, [groupIndex, 1]);
    rule = currentRule(ruleId);
    expect(rule.conditions.conditions.every((condition) => condition.kind === 'predicate')).toBe(true);
    expect(rule.conditions.conditions).toHaveLength(3);
    expect(workspace.getSnapshot().notice).toContain('自动合并');

    rules.addConditionGroup(ruleId, []);
    rules.removeCondition(ruleId, [currentRule(ruleId).conditions.conditions.length - 1]);
    expect(workspace.getSnapshot().notice).toContain('已移除嵌套条件组');

    rules.addRule();
    const freshId = workspace.getSnapshot().selectedRuleId ?? '';
    rules.removeCondition(freshId, [0]);
    expect(currentRule(freshId).conditions.conditions).toHaveLength(1);
    expect(workspace.getSnapshot().notice).toContain('至少需要一个条件');
    workspace.dispose();
  });
});
