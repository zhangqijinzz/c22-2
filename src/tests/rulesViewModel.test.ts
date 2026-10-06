import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateSample } from '../domain/conditionEvaluator';
import { RulesViewModel } from '../features/rules/rulesViewModel';
import type { BusinessRule, RuleProject, WorkspaceDocument } from '../models/ruleModel';
import { RuleRepository } from '../repositories/ruleRepository';
import { ProjectStorageService } from '../services/projectStorageService';
import { RuleWorkspaceViewModel } from '../viewmodels/workspaceViewModel';

class MemoryRepository {
  async load() { return null; }
  async save() { return undefined; }
}

class FakeChecker {
  run() {
    return {
      promise: Promise.resolve({ checkedCases: 1, coveredCases: 1, coveragePercent: 100, overlaps: [], unreachableRuleIds: [], shadowedRuleIds: [], uncoveredExamples: [], truncated: false }),
      cancel() {},
    };
  }
}

async function setup() {
  const workspace = new RuleWorkspaceViewModel(new MemoryRepository(), new FakeChecker());
  await workspace.start();
  return { workspace, rules: new RulesViewModel(workspace) };
}

function rule(workspace: RuleWorkspaceViewModel, ruleId: string): BusinessRule {
  const found = workspace.getSnapshot().project?.rules.find((candidate) => candidate.id === ruleId);
  if (!found) throw new Error(`规则 ${ruleId} 不存在`);
  return found;
}

describe('RulesViewModel nested condition editing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('builds a nested group and edits it into “金卡 AND (优惠券 OR 金额≥1500)”', async () => {
    const { workspace, rules } = await setup();
    rules.addGroup('rule-gold-discount', []);
    const nested = rule(workspace, 'rule-gold-discount').conditions.conditions[2];
    expect(rule(workspace, 'rule-gold-discount').conditions.conditions).toHaveLength(3);
    expect(nested.kind).toBe('group');
    if (nested.kind !== 'group') return;
    expect(nested.operator).toBe('or');
    expect(nested.conditions).toHaveLength(2);

    rules.updateCondition('rule-gold-discount', [2, 0], { kind: 'predicate', fieldId: 'coupon-active', operator: 'isTrue', value: true });
    rules.updateCondition('rule-gold-discount', [2, 1], { kind: 'predicate', fieldId: 'cart-total', operator: 'gte', value: 1500 });
    rules.removeCondition('rule-gold-discount', [1]);
    const conditions = rule(workspace, 'rule-gold-discount').conditions;
    expect(conditions.conditions).toHaveLength(2);
    expect(conditions.conditions[1].kind).toBe('group');
    expect(workspace.getSnapshot().validationIssues.filter((issue) => issue.ruleId === 'rule-gold-discount')).toEqual([]);

    const project = workspace.getSnapshot().project as RuleProject;
    const hits = (values: RuleProject['sampleInputs']) => evaluateSample(project, values).matchedRules.map((matched) => matched.id);
    expect(hits({ 'member-level': '金卡会员', 'cart-total': 100, 'coupon-active': true })).toContain('rule-gold-discount');
    expect(hits({ 'member-level': '金卡会员', 'cart-total': 2000, 'coupon-active': false })).toContain('rule-gold-discount');
    expect(hits({ 'member-level': '金卡会员', 'cart-total': 100, 'coupon-active': false })).not.toContain('rule-gold-discount');
    workspace.dispose();
  });

  it('unwraps a nested group when a removal leaves it with a single child', async () => {
    const { workspace, rules } = await setup();
    rules.addGroup('rule-gold-discount', []);
    rules.removeCondition('rule-gold-discount', [2, 0]);
    const conditions = rule(workspace, 'rule-gold-discount').conditions;
    expect(conditions.conditions).toHaveLength(3);
    expect(conditions.conditions[2].kind).toBe('predicate');
    expect(workspace.getSnapshot().notice).toContain('自动展开');
    workspace.dispose();
  });

  it('blocks removing the last remaining condition of a rule', async () => {
    const { workspace, rules } = await setup();
    rules.removeCondition('rule-out-of-range', [0]);
    expect(rule(workspace, 'rule-out-of-range').conditions.conditions).toHaveLength(1);
    expect(workspace.getSnapshot().notice).toContain('至少需要保留一个条件');
    workspace.dispose();
  });

  it('deletes a nested group but blocks deleting the only root child', async () => {
    const { workspace, rules } = await setup();
    rules.addGroup('rule-gold-discount', []);
    rules.removeGroup('rule-gold-discount', [2]);
    const conditions = rule(workspace, 'rule-gold-discount').conditions;
    expect(conditions.conditions).toHaveLength(2);
    expect(conditions.conditions.every((condition) => condition.kind === 'predicate')).toBe(true);

    const project = workspace.getSnapshot().project as RuleProject;
    const nestedOnly: BusinessRule = {
      id: 'rule-nested-only', name: '仅嵌套', priority: 5, result: '结果',
      conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'group', operator: 'or', conditions: [
        { kind: 'predicate', fieldId: 'member-level', operator: 'eq', value: '金卡会员' },
        { kind: 'predicate', fieldId: 'coupon-active', operator: 'isTrue', value: true },
      ] }] },
    };
    workspace.commitProject({ ...project, rules: [...project.rules, nestedOnly] });
    rules.removeGroup('rule-nested-only', [0]);
    expect(rule(workspace, 'rule-nested-only').conditions.conditions).toHaveLength(1);
    expect(workspace.getSnapshot().notice).toContain('至少需要保留一个条件');
    workspace.dispose();
  });

  it('keeps single-layer rules evaluating normally after edits', async () => {
    const { workspace, rules } = await setup();
    rules.changeConditionField('rule-coupon-discount', [0], 'cart-total');
    rules.updateCondition('rule-coupon-discount', [0], { kind: 'predicate', fieldId: 'cart-total', operator: 'gte', value: 850 });
    rules.setGroupOperator('rule-coupon-discount', [], 'or');
    const edited = rule(workspace, 'rule-coupon-discount');
    expect(edited.conditions.operator).toBe('or');
    expect(edited.conditions.conditions[0]).toMatchObject({ fieldId: 'cart-total', operator: 'gte', value: 850 });

    const project = workspace.getSnapshot().project as RuleProject;
    const hits = (values: RuleProject['sampleInputs']) => evaluateSample(project, values).matchedRules.map((matched) => matched.id);
    expect(hits({ 'member-level': '普通会员', 'cart-total': 900, 'coupon-active': false })).toContain('rule-coupon-discount');
    expect(hits({ 'member-level': '普通会员', 'cart-total': 100, 'coupon-active': false })).not.toContain('rule-coupon-discount');
    const ordered = hits({ 'member-level': '金卡会员', 'cart-total': 1200, 'coupon-active': true });
    expect(ordered.slice(0, 2)).toEqual(['rule-gold-discount', 'rule-coupon-discount']);
    workspace.dispose();
  });
});

describe('nested rule persistence', () => {
  it('keeps nested groups and flat rules intact through a save/load round trip', async () => {
    class MemoryStorage extends ProjectStorageService {
      value: unknown = null;
      override async read() { return this.value; }
      override readFallback() { return null; }
      override async write(document: WorkspaceDocument) { this.value = structuredClone(document); }
    }
    const repository = new RuleRepository(new MemoryStorage());
    const nested: BusinessRule = {
      id: 'rule-nested', name: '嵌套', priority: 10, result: '礼遇',
      conditions: { kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'member-level', operator: 'eq', value: '金卡会员' },
        { kind: 'group', operator: 'or', conditions: [
          { kind: 'predicate', fieldId: 'coupon-active', operator: 'isTrue', value: true },
          { kind: 'predicate', fieldId: 'cart-total', operator: 'gte', value: 1500 },
        ] },
      ] },
    };
    const flat: BusinessRule = {
      id: 'rule-flat', name: '单层', priority: 20, result: '基础',
      conditions: { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'cart-total', operator: 'gte', value: 100 }] },
    };
    const project: RuleProject = {
      id: 'p1', title: '回环',
      fields: [
        { id: 'member-level', name: '会员等级', type: 'enum', enumValues: ['普通会员', '金卡会员'] },
        { id: 'cart-total', name: '订单金额', type: 'number', min: 0, max: 5000 },
        { id: 'coupon-active', name: '使用优惠券', type: 'boolean' },
      ],
      rules: [nested, flat], sampleInputs: {}, versions: [], updatedAt: 1,
    };
    await repository.save({ schemaVersion: 1, projects: [project], activeProjectId: 'p1' });
    const loaded = await repository.load();
    expect(loaded?.projects[0].rules[0].conditions).toEqual(nested.conditions);
    expect(loaded?.projects[0].rules[1].conditions).toEqual(flat.conditions);

    const loadedProject = loaded?.projects[0] as RuleProject;
    expect(evaluateSample(loadedProject, { 'member-level': '金卡会员', 'cart-total': 2000, 'coupon-active': false }).winner?.id).toBe('rule-flat');
    expect(evaluateSample(loadedProject, { 'member-level': '金卡会员', 'cart-total': 50, 'coupon-active': true }).winner?.id).toBe('rule-nested');
  });
});
