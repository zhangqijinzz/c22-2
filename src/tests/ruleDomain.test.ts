import { describe, expect, it } from 'vitest';
import { evaluateSample } from '../domain/conditionEvaluator';
import {
  appendConditionAtPath,
  getConditionAtPath,
  normalizeConditionTree,
  removeConditionAtPath,
  replaceConditionAtPath,
  setGroupOperatorAtPath,
} from '../domain/conditionTree';
import { validateField, validateProject } from '../domain/fieldValidation';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { BusinessRule, ConditionGroup, RuleField, RuleProject } from '../models/ruleModel';

const amount: RuleField = { id: 'amount', name: '金额', type: 'number', min: 0, max: 1000 };
const tier: RuleField = { id: 'tier', name: '等级', type: 'enum', enumValues: ['basic', 'gold'] };
const active: RuleField = { id: 'active', name: '启用', type: 'boolean' };

function makeRule(id: string, conditions: BusinessRule['conditions'], priority = 10, result = id): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

function project(rules: BusinessRule[], fields: RuleField[] = [amount, tier, active]): RuleProject {
  return { id: 'p', title: '测试项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

const amountAtLeast = (value: number): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'gte', value }] });

describe('field and project validation', () => {
  it('accepts inclusive boundary ranges and rejects reversed or empty definitions', () => {
    expect(validateField({ ...amount, min: 5, max: 5 })).toEqual([]);
    expect(validateField({ ...amount, min: 11, max: 10 }).map((issue) => issue.code)).toContain('number-range-order');
    expect(validateField({ id: 'tier', name: '等级', type: 'enum', enumValues: [] }).map((issue) => issue.code)).toContain('enum-values-required');
  });

  it('checks enum and boolean predicate types without depending on React', () => {
    const rules = [
      makeRule('gold', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' }] }),
      makeRule('active', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true }] }),
    ];
    expect(validateProject(project(rules))).toEqual([]);
    expect(evaluateSample(project(rules), { amount: 12, tier: 'gold', active: true }).matchedRules.map((rule) => rule.id)).toEqual(['gold', 'active']);
  });
});

describe('rule consistency analysis', () => {
  it('finds partial overlap, same-priority conflicts, lower-priority shadowing, unreachable rules, and gaps', () => {
    const rules = [
      makeRule('base', amountAtLeast(500), 10, 'standard'),
      makeRule('partial', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'between', value: { min: 300, max: 800 } }] }, 20, 'special'),
      makeRule('conflict', amountAtLeast(700), 20, 'different'),
      makeRule('hidden', amountAtLeast(750), 5, 'hidden'),
      makeRule('impossible', amountAtLeast(1001), 50, 'out of range'),
      makeRule('no-overlap', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 250 }] }, 1, 'separate'),
    ];
    const analysis = analyzeRules(project(rules));
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'partial' && overlap.ruleBId === 'conflict' && overlap.conflict)).toBe(true);
    expect(analysis.overlaps.some((overlap) => overlap.ruleAId === 'base' && overlap.ruleBId === 'no-overlap')).toBe(false);
    expect(analysis.unreachableRuleIds).toContain('impossible');
    expect(analysis.shadowedRuleIds).toContain('hidden');
    expect(analysis.uncoveredExamples.length).toBeGreaterThan(0);
    expect(analysis.checkedCases).toBeGreaterThan(0);
  });

  it('evaluates OR groups and validates missing sample inputs precisely', () => {
    const rule = makeRule('either', { kind: 'group', operator: 'or', conditions: [
      { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' },
      { kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true },
    ] });
    const result = evaluateSample(project([rule]), { amount: 10, tier: 'basic', active: true });
    expect(result.valid).toBe(true);
    expect(result.winner?.id).toBe('either');
    const missing = evaluateSample(project([rule]), { amount: 10, tier: 'gold' });
    expect(missing.errors).toEqual(['请填写“启用”']);
  });
});

describe('nested condition groups', () => {
  const cart: RuleField = { id: 'cart', name: '订单金额', type: 'number', min: 0, max: 5000 };
  const member: RuleField = { id: 'member', name: '会员等级', type: 'enum', enumValues: ['普通会员', '金卡会员'] };
  const coupon: RuleField = { id: 'coupon', name: '使用优惠券', type: 'boolean' };
  const nestedFields = [cart, member, coupon];

  // 金卡会员，同时（优惠券已用 或 金额满一千五）——过去必须拆成两条规则的判断
  const goldFlexConditions = (): BusinessRule['conditions'] => ({ kind: 'group', operator: 'and', conditions: [
    { kind: 'predicate', fieldId: 'member', operator: 'eq', value: '金卡会员' },
    { kind: 'group', operator: 'or', conditions: [
      { kind: 'predicate', fieldId: 'coupon', operator: 'isTrue', value: true },
      { kind: 'predicate', fieldId: 'cart', operator: 'gte', value: 1500 },
    ] },
  ] });

  it('evaluates a nested AND/OR group through each branch', () => {
    const proj = project([makeRule('gold-flex', goldFlexConditions(), 20, '金卡礼遇')], nestedFields);
    const winnerOf = (values: RuleProject['sampleInputs']) => evaluateSample(proj, values).winner?.id;
    expect(winnerOf({ cart: 100, member: '金卡会员', coupon: true })).toBe('gold-flex');
    expect(winnerOf({ cart: 2000, member: '金卡会员', coupon: false })).toBe('gold-flex');
    expect(winnerOf({ cart: 100, member: '金卡会员', coupon: false })).toBeUndefined();
    expect(winnerOf({ cart: 2000, member: '普通会员', coupon: true })).toBeUndefined();
  });

  it('gives one interpretation across sample hits, overlaps, conflicts, and shadowing', () => {
    const rules = [
      makeRule('gold-flex', goldFlexConditions(), 20, '金卡礼遇'),
      makeRule('gold-basic', { kind: 'group', operator: 'and', conditions: [{ kind: 'predicate', fieldId: 'member', operator: 'eq', value: '金卡会员' }] }, 20, '金卡基础'),
      makeRule('coupon-light', { kind: 'group', operator: 'and', conditions: [
        { kind: 'predicate', fieldId: 'coupon', operator: 'isTrue', value: true },
        { kind: 'predicate', fieldId: 'cart', operator: 'lt', value: 500 },
      ] }, 10, '小额券'),
      makeRule('gold-shadow', goldFlexConditions(), 5, '低优先级礼遇'),
    ];
    const proj = project(rules, nestedFields);
    const analysis = analyzeRules(proj);

    // 遮蔽：gold-shadow 与 gold-flex 条件相同但优先级更低，永远轮不到它
    expect(analysis.shadowedRuleIds).toContain('gold-shadow');
    // 冲突：gold-flex 与 gold-basic 同优先级、结果不同且条件重叠
    const conflict = analysis.overlaps.find((overlap) => [overlap.ruleAId, overlap.ruleBId].sort().join('|') === 'gold-basic|gold-flex');
    expect(conflict?.conflict).toBe(true);
    // 重叠但非冲突：优先级不同
    const benign = analysis.overlaps.find((overlap) => [overlap.ruleAId, overlap.ruleBId].sort().join('|') === 'coupon-light|gold-flex');
    expect(benign?.conflict).toBe(false);

    // 每一个重叠见证输入，样例推演的命中集合、命中顺序与胜出者都与检查口径一致
    for (const overlap of analysis.overlaps) {
      const evaluation = evaluateSample(proj, overlap.witness);
      const hitIds = evaluation.matchedRules.map((rule) => rule.id);
      expect(hitIds).toContain(overlap.ruleAId);
      expect(hitIds).toContain(overlap.ruleBId);
      const priorities = evaluation.matchedRules.map((rule) => rule.priority);
      expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
      expect(evaluation.winner?.id).toBe(hitIds[0]);
      if (hitIds.includes('gold-shadow')) expect(evaluation.winner?.id).not.toBe('gold-shadow');
    }
    // 冲突见证下，同优先级按规则列表顺序决胜：gold-flex 在 gold-basic 之前
    expect(evaluateSample(proj, conflict?.witness ?? {}).winner?.id).toBe('gold-flex');
  });

  it('flags empty nested groups and single-child groups but accepts a single-condition root', () => {
    const broken = makeRule('nested-bad', { kind: 'group', operator: 'and', conditions: [
      { kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 1 },
      { kind: 'group', operator: 'or', conditions: [{ kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true }] },
      { kind: 'group', operator: 'or', conditions: [] },
    ] });
    const codes = validateProject(project([broken])).map((issue) => issue.code);
    expect(codes).toContain('single-child-group');
    expect(codes).toContain('empty-condition-group');
    expect(validateProject(project([makeRule('flat', amountAtLeast(10))]))).toEqual([]);
  });
});

describe('condition tree editing helpers', () => {
  const predA: BusinessRule['conditions']['conditions'][number] = { kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 100 };
  const predB: BusinessRule['conditions']['conditions'][number] = { kind: 'predicate', fieldId: 'tier', operator: 'eq', value: 'gold' };
  const predC: BusinessRule['conditions']['conditions'][number] = { kind: 'predicate', fieldId: 'active', operator: 'isTrue', value: true };
  const predD: BusinessRule['conditions']['conditions'][number] = { kind: 'predicate', fieldId: 'amount', operator: 'lt', value: 50 };

  it('gets, replaces, appends, removes, and re-operates by path without mutating the original', () => {
    const tree: ConditionGroup = { kind: 'group', operator: 'and', conditions: [predA, { kind: 'group', operator: 'or', conditions: [predB, predC] }] };
    expect(getConditionAtPath(tree, [])).toBe(tree);
    expect(getConditionAtPath(tree, [1, 0])).toBe(predB);
    expect(getConditionAtPath(tree, [9])).toBeUndefined();

    const replaced = replaceConditionAtPath(tree, [1, 1], predD);
    expect(getConditionAtPath(replaced, [1, 1])).toBe(predD);
    expect(getConditionAtPath(tree, [1, 1])).toBe(predC);

    const appended = appendConditionAtPath(tree, [1], predD);
    expect((getConditionAtPath(appended, [1]) as ConditionGroup).conditions).toHaveLength(3);
    expect((getConditionAtPath(tree, [1]) as ConditionGroup).conditions).toHaveLength(2);

    const removed = removeConditionAtPath(tree, [1, 0]);
    expect((getConditionAtPath(removed, [1]) as ConditionGroup).conditions).toEqual([predC]);

    const switched = setGroupOperatorAtPath(tree, [1], 'and');
    expect((getConditionAtPath(switched, [1]) as ConditionGroup).operator).toBe('and');
    expect((getConditionAtPath(tree, [1]) as ConditionGroup).operator).toBe('or');
  });

  it('drops empty nested groups and unwraps single-child groups, cascading upward', () => {
    const tree: ConditionGroup = { kind: 'group', operator: 'and', conditions: [
      predA,
      { kind: 'group', operator: 'or', conditions: [] },
      { kind: 'group', operator: 'or', conditions: [predB] },
      { kind: 'group', operator: 'and', conditions: [{ kind: 'group', operator: 'or', conditions: [predC] }] },
    ] };
    const normalized = normalizeConditionTree(tree);
    expect(normalized.conditions).toEqual([predA, predB, predC]);
    expect(normalized.operator).toBe('and');
  });

  it('keeps the root group shape even with zero or one child and returns the same reference when unchanged', () => {
    const single: ConditionGroup = { kind: 'group', operator: 'and', conditions: [predA] };
    expect(normalizeConditionTree(single)).toBe(single);
    const empty: ConditionGroup = { kind: 'group', operator: 'and', conditions: [] };
    expect(normalizeConditionTree(empty)).toBe(empty);
    const flat: ConditionGroup = { kind: 'group', operator: 'or', conditions: [predA, predB] };
    expect(normalizeConditionTree(flat)).toBe(flat);
  });
});
