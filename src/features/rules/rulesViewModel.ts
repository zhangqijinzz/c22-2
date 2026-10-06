import {
  appendConditionAtPath,
  getConditionAtPath,
  normalizeConditionTree,
  removeConditionAtPath,
  replaceConditionAtPath,
  setGroupOperatorAtPath,
} from '../../domain/conditionTree';
import type { BusinessRule, ConditionGroup, PredicateCondition, RuleField, RuleProject } from '../../models/ruleModel';
import type { WorkspacePort } from '../../viewmodels/workspacePort';

/**
 * 规则编辑的全部写操作都按“条件树路径”寻址（根组为 []，每深入一层追加一个子项索引），
 * 删除后统一经过 normalizeConditionTree，保证空条件组和单子项分组不会留在结构里。
 */
export class RulesViewModel {
  constructor(private readonly workspace: WorkspacePort) {}

  selectRule(ruleId: string): void {
    this.workspace.selectRule(ruleId);
  }

  addRule(): void {
    const project = this.currentProject();
    if (!project) return;
    const ordinal = project.rules.length + 1;
    const field = project.fields.find((candidate) => candidate.type === 'number' || candidate.type === 'enum' || candidate.type === 'boolean');
    const conditions: ConditionGroup = { kind: 'group', operator: 'and', conditions: field ? [defaultCondition(field)] : [] };
    const rule: BusinessRule = { id: makeId('rule'), name: `新规则 ${ordinal}`, conditions, priority: ordinal * 10, result: '' };
    this.workspace.commitProject({ ...project, rules: [...project.rules, rule] }, `已创建“${rule.name}”`);
    this.workspace.selectRule(rule.id);
  }

  updateRule(ruleId: string, updates: Partial<Pick<BusinessRule, 'name' | 'priority' | 'result'>>): void {
    this.updateRules((rule) => rule.id === ruleId ? { ...rule, ...updates } : rule, `${this.findName(ruleId)}已更新`);
  }

  removeRule(ruleId: string): void {
    const project = this.currentProject();
    if (!project) return;
    const name = this.findName(ruleId);
    this.workspace.commitProject({ ...project, rules: project.rules.filter((rule) => rule.id !== ruleId) }, `已删除${name}`);
    if (this.workspace.getSnapshot().selectedRuleId === ruleId) this.workspace.selectRule(project.rules.find((rule) => rule.id !== ruleId)?.id);
  }

  setGroupOperator(ruleId: string, path: number[], operator: ConditionGroup['operator']): void {
    this.updateRules(
      (rule) => rule.id === ruleId ? { ...rule, conditions: setGroupOperatorAtPath(rule.conditions, path, operator) } : rule,
      '条件组合已更新',
    );
  }

  addCondition(ruleId: string, groupPath: number[] = []): void {
    const project = this.currentProject();
    const field = project?.fields[0];
    if (!project || !field) {
      this.workspace.updateView({ notice: '请先定义至少一个字段，再添加规则条件。' });
      return;
    }
    this.updateRules(
      (rule) => rule.id === ruleId
        ? { ...rule, conditions: appendConditionAtPath(rule.conditions, groupPath, defaultCondition(field)) }
        : rule,
      '已添加一个条件',
    );
  }

  addGroup(ruleId: string, parentPath: number[] = []): void {
    const project = this.currentProject();
    const fields = project?.fields ?? [];
    if (!project || fields.length === 0) {
      this.workspace.updateView({ notice: '请先定义至少一个字段，再添加规则条件。' });
      return;
    }
    const rule = project.rules.find((candidate) => candidate.id === ruleId);
    const parent = rule ? getConditionAtPath(rule.conditions, parentPath) : undefined;
    if (!rule || !parent || parent.kind !== 'group') return;
    const group: ConditionGroup = {
      kind: 'group',
      operator: parent.operator === 'and' ? 'or' : 'and',
      conditions: [defaultCondition(fields[0]), defaultCondition(fields[1] ?? fields[0])],
    };
    this.updateRules(
      (candidate) => candidate.id === ruleId
        ? { ...candidate, conditions: appendConditionAtPath(candidate.conditions, parentPath, group) }
        : candidate,
      '已添加条件组，可在组内切换 AND / OR',
    );
  }

  updateCondition(ruleId: string, path: number[], condition: PredicateCondition): void {
    this.updateRules(
      (rule) => rule.id === ruleId ? { ...rule, conditions: replaceConditionAtPath(rule.conditions, path, condition) } : rule,
      '规则条件已更新',
    );
  }

  changeConditionField(ruleId: string, path: number[], fieldId: string): void {
    const field = this.currentProject()?.fields.find((candidate) => candidate.id === fieldId);
    if (field) this.updateCondition(ruleId, path, defaultCondition(field));
  }

  removeCondition(ruleId: string, path: number[]): void {
    if (path.length === 0) return;
    this.removeNode(ruleId, path, '已移除一个条件', '已移除条件，冗余条件组已自动展开');
  }

  removeGroup(ruleId: string, path: number[]): void {
    if (path.length === 0) return;
    const rule = this.currentProject()?.rules.find((candidate) => candidate.id === ruleId);
    const target = rule ? getConditionAtPath(rule.conditions, path) : undefined;
    if (!target || target.kind !== 'group') return;
    this.removeNode(ruleId, path, '已删除条件组', '已删除条件组，冗余条件组已自动展开');
  }

  private removeNode(ruleId: string, path: number[], plainNotice: string, collapsedNotice: string): void {
    const rule = this.currentProject()?.rules.find((candidate) => candidate.id === ruleId);
    if (!rule) return;
    const removed = removeConditionAtPath(rule.conditions, path);
    const normalized = normalizeConditionTree(removed);
    if (normalized.conditions.length === 0) {
      this.workspace.updateView({ notice: `${this.findName(ruleId)}至少需要保留一个条件，无法移除。` });
      return;
    }
    const collapsed = normalized !== removed;
    this.updateRules(
      (candidate) => candidate.id === ruleId ? { ...candidate, conditions: normalized } : candidate,
      collapsed ? collapsedNotice : plainNotice,
    );
  }

  private currentProject(): RuleProject | null {
    return this.workspace.getSnapshot().project;
  }

  private findName(ruleId: string): string {
    return this.currentProject()?.rules.find((rule) => rule.id === ruleId)?.name ?? '规则';
  }

  private updateRules(update: (rule: BusinessRule) => BusinessRule, notice: string): void {
    const project = this.currentProject();
    if (project) this.workspace.commitProject({ ...project, rules: project.rules.map(update) }, notice);
  }
}

function defaultCondition(field: RuleField): PredicateCondition {
  if (field.type === 'number') return { kind: 'predicate', fieldId: field.id, operator: 'gte', value: field.min ?? 0 };
  if (field.type === 'enum') return { kind: 'predicate', fieldId: field.id, operator: 'eq', value: field.enumValues?.[0] ?? '' };
  return { kind: 'predicate', fieldId: field.id, operator: 'isTrue', value: true };
}

function makeId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}
