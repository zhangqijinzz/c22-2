import { describe, expect, it } from 'vitest';
import { evaluateSample, group, matchesCondition, predicate } from '../domain/conditionEvaluator';
import { normalizeConditionGroup } from '../domain/conditionEditing';
import { validateProject } from '../domain/fieldValidation';
import { analyzeRules } from '../domain/ruleAnalysis';
import type { BusinessRule, ConditionGroup, RuleField, RuleProject, SampleInput } from '../models/ruleModel';

const level: RuleField = { id: 'level', name: '会员等级', type: 'enum', enumValues: ['普通会员', '金卡会员'] };
const coupon: RuleField = { id: 'coupon', name: '优惠券已用', type: 'boolean' };
const amount: RuleField = { id: 'amount', name: '订单金额', type: 'number', min: 0, max: 5000 };
const fields = [level, coupon, amount];

const goldMember = predicate({ kind: 'predicate', fieldId: 'level', operator: 'eq', value: '金卡会员' });
const couponUsed = predicate({ kind: 'predicate', fieldId: 'coupon', operator: 'isTrue', value: true });
const bigOrder = predicate({ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 1500 });
const hugeOrder = predicate({ kind: 'predicate', fieldId: 'amount', operator: 'gte', value: 2000 });

/** 金卡会员，同时（优惠券已用 或者 金额满一千五）。 */
const nestedConditions: ConditionGroup = group('and', goldMember, group('or', couponUsed, bigOrder));

function makeRule(id: string, conditions: ConditionGroup, priority: number, result: string): BusinessRule {
  return { id, name: id, conditions, priority, result };
}

const nestedRule = makeRule('nested', nestedConditions, 30, '免运费');
const shadowedRule = makeRule('shadowed', group('and', goldMember, couponUsed), 10, '赠品');
const conflictRule = makeRule('conflict', group('and', hugeOrder), 30, '全额返现');

function project(rules: BusinessRule[]): RuleProject {
  return { id: 'p', title: '嵌套条件项目', fields, rules, sampleInputs: {}, versions: [], updatedAt: 1 };
}

describe('nested condition evaluation', () => {
  it('evaluates “金卡 AND (已用券 OR 金额满 1500)” as one rule', () => {
    const proj = project([nestedRule]);
    const hit = (values: SampleInput) => evaluateSample(proj, values).matchedRules.map((rule) => rule.id);
    expect(hit({ level: '金卡会员', coupon: true, amount: 100 })).toEqual(['nested']);
    expect(hit({ level: '金卡会员', coupon: false, amount: 1500 })).toEqual(['nested']);
    expect(hit({ level: '金卡会员', coupon: false, amount: 1499 })).toEqual([]);
    expect(hit({ level: '普通会员', coupon: true, amount: 2000 })).toEqual([]);
  });

  it('gives one consistent interpretation across sampling, overlap and shadowing', () => {
    const proj = project([nestedRule, shadowedRule, conflictRule]);
    const analysis = analyzeRules(proj);

    expect(analysis.unreachableRuleIds).toEqual([]);
    expect(analysis.shadowedRuleIds).toEqual(['shadowed']);

    const pair = (a: string, b: string) => analysis.overlaps.find((overlap) => [overlap.ruleAId, overlap.ruleBId].sort().join('|') === [a, b].sort().join('|'));
    expect(pair('nested', 'shadowed')?.conflict).toBe(false);
    expect(pair('nested', 'conflict')?.conflict).toBe(true);
    expect(pair('shadowed', 'conflict')?.conflict).toBe(false);

    const byId = new Map(proj.rules.map((rule) => [rule.id, rule]));
    for (const overlap of analysis.overlaps) {
      const evaluation = evaluateSample(proj, overlap.witness);
      expect(evaluation.valid).toBe(true);
      const matchedIds = evaluation.matchedRules.map((rule) => rule.id);
      expect(matchedIds).toContain(overlap.ruleAId);
      expect(matchedIds).toContain(overlap.ruleBId);
      // 检查记录先后（ruleAId 先于 ruleBId）与样例推演的命中顺序一致
      expect(matchedIds.indexOf(overlap.ruleAId)).toBeLessThan(matchedIds.indexOf(overlap.ruleBId));
      // 命中顺序始终按优先级降序、同优先级按列表顺序，胜者为队首
      const orderedIds = [...proj.rules]
        .sort((a, b) => b.priority - a.priority || proj.rules.indexOf(a) - proj.rules.indexOf(b))
        .map((rule) => rule.id)
        .filter((id) => matchedIds.includes(id));
      expect(matchedIds).toEqual(orderedIds);
      expect(evaluation.winner?.id).toBe(matchedIds[0]);
      const ruleA = byId.get(overlap.ruleAId) as BusinessRule;
      const ruleB = byId.get(overlap.ruleBId) as BusinessRule;
      expect(overlap.conflict).toBe(ruleA.priority === ruleB.priority && ruleA.result !== ruleB.result);
    }

    const hitOrder = evaluateSample(proj, { level: '金卡会员', coupon: true, amount: 2000 }).matchedRules.map((rule) => rule.id);
    expect(hitOrder).toEqual(['nested', 'conflict', 'shadowed']);
  });

  it('keeps single-layer rules evaluating exactly as before', () => {
    const flatAnd = makeRule('and-rule', group('and', goldMember, bigOrder), 10, 'A');
    const flatOr = makeRule('or-rule', group('or', couponUsed, goldMember), 20, 'B');
    const proj = project([flatAnd, flatOr]);
    const hit = (values: SampleInput) => evaluateSample(proj, values).matchedRules.map((rule) => rule.id);
    expect(hit({ level: '金卡会员', coupon: false, amount: 1500 })).toEqual(['or-rule', 'and-rule']);
    expect(hit({ level: '普通会员', coupon: true, amount: 0 })).toEqual(['or-rule']);
    expect(hit({ level: '普通会员', coupon: false, amount: 100 })).toEqual([]);

    const analysis = analyzeRules(proj);
    expect(analysis.shadowedRuleIds).toEqual(['and-rule']);
    expect(analysis.overlaps).toHaveLength(1);
    expect(analysis.overlaps[0].conflict).toBe(false);
  });
});

describe('normalizeConditionGroup', () => {
  it('collapses single-child nested groups and drops empty ones', () => {
    const collapsed = normalizeConditionGroup(group('and', goldMember, group('or', couponUsed)));
    expect(collapsed.conditions).toEqual([goldMember, couponUsed]);

    const dropped = normalizeConditionGroup(group('and', goldMember, group('or')));
    expect(dropped.conditions).toEqual([goldMember]);

    const deep = normalizeConditionGroup(group('and', goldMember, group('and', couponUsed, group('or', bigOrder))));
    expect(deep.conditions).toEqual([goldMember, group('and', couponUsed, bigOrder)]);
  });

  it('returns flat and already-normalized structures untouched', () => {
    const flat = group('and', goldMember, couponUsed);
    expect(normalizeConditionGroup(flat)).toBe(flat);
    const nested = group('and', goldMember, group('or', couponUsed, bigOrder));
    expect(normalizeConditionGroup(nested)).toBe(nested);
  });

  it('preserves matching semantics when collapsing single-child groups', () => {
    const original = group('and', goldMember, group('or', couponUsed, group('and', bigOrder)));
    const normalized = normalizeConditionGroup(original);
    const samples: SampleInput[] = [];
    for (const member of level.enumValues ?? []) {
      for (const used of [false, true]) {
        for (const total of [0, 1499, 1500, 5000]) samples.push({ level: member, coupon: used, amount: total });
      }
    }
    for (const sample of samples) expect(matchesCondition(normalized, sample)).toBe(matchesCondition(original, sample));
  });
});

describe('nested structure validation', () => {
  it('flags empty groups and single-child nested groups, but allows a single-condition root', () => {
    const badSingle = makeRule('bad-single', group('and', goldMember, group('or', couponUsed)), 10, 'x');
    const badEmpty = makeRule('bad-empty', group('and', goldMember, group('or')), 10, 'x');
    const rootSingle = makeRule('root-single', group('and', goldMember), 10, 'x');
    expect(validateProject(project([badSingle])).map((issue) => issue.code)).toContain('single-child-group');
    expect(validateProject(project([badEmpty])).map((issue) => issue.code)).toContain('empty-condition');
    expect(validateProject(project([rootSingle])).filter((issue) => issue.code === 'single-child-group' || issue.code === 'empty-condition')).toEqual([]);
  });
});
