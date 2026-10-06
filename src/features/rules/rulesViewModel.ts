import {
  getConditionGroup,
  getConditionNode,
  mapConditionGroup,
  normalizeConditionGroup,
  removeConditionNode,
  replaceConditionNode,
  type ConditionPath,
} from '../../domain/conditionEditing';
import type { BusinessRule, ConditionGroup, PredicateCondition, RuleField, RuleProject } from '../../models/ruleModel';
import type { WorkspacePort } from '../../viewmodels/workspacePort';

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

  setGroupOperator(ruleId: string, path: ConditionPath, operator: ConditionGroup['operator']): void {
    this.updateConditions(ruleId, (root) => mapConditionGroup(root, path, (group) => ({ ...group, operator })), '条件组合已更新');
  }

  addCondition(ruleId: string, groupPath: ConditionPath): void {
    const field = this.firstField();
    if (!field) return;
    this.updateConditions(ruleId, (root) => mapConditionGroup(root, groupPath, (group) => ({ ...group, conditions: [...group.conditions, defaultCondition(field)] })), '已添加一个条件');
  }

  addConditionGroup(ruleId: string, groupPath: ConditionPath): void {
    const field = this.firstField();
    if (!field) return;
    const subgroup: ConditionGroup = { kind: 'group', operator: 'or', conditions: [defaultCondition(field), defaultCondition(field)] };
    this.updateConditions(ruleId, (root) => mapConditionGroup(root, groupPath, (group) => ({ ...group, conditions: [...group.conditions, subgroup] })), '已添加嵌套条件组，可调整组内条件与组合方式');
  }

  updateCondition(ruleId: string, path: ConditionPath, condition: PredicateCondition): void {
    this.updateConditions(ruleId, (root) => replaceConditionNode(root, path, condition), '规则条件已更新');
  }

  changeConditionField(ruleId: string, path: ConditionPath, fieldId: string): void {
    const field = this.currentProject()?.fields.find((candidate) => candidate.id === fieldId);
    if (field) this.updateCondition(ruleId, path, defaultCondition(field));
  }

  removeCondition(ruleId: string, path: ConditionPath): void {
    const rule = this.currentProject()?.rules.find((candidate) => candidate.id === ruleId);
    if (!rule || path.length === 0) return;
    const parentPath = path.slice(0, -1);
    const parent = getConditionGroup(rule.conditions, parentPath);
    if (!parent) return;
    if (parentPath.length === 0 && parent.conditions.length <= 1) {
      this.workspace.updateView({ notice: '规则至少需要一个条件，无法移除最后一个条件。' });
      return;
    }
    const removed = getConditionNode(rule.conditions, path);
    const collapsesParent = parentPath.length > 0 && parent.conditions.length === 2;
    const notice = removed?.kind === 'group'
      ? '已移除嵌套条件组'
      : collapsesParent
        ? '已移除条件，仅剩一项的条件组已自动合并'
        : '已移除一个条件';
    this.updateConditions(ruleId, (root) => removeConditionNode(root, path), notice);
  }

  private firstField(): RuleField | null {
    const field = this.currentProject()?.fields[0];
    if (!field) {
      this.workspace.updateView({ notice: '请先定义至少一个字段，再添加规则条件。' });
      return null;
    }
    return field;
  }

  private currentProject(): RuleProject | null {
    return this.workspace.getSnapshot().project;
  }

  private findName(ruleId: string): string {
    return this.currentProject()?.rules.find((rule) => rule.id === ruleId)?.name ?? '规则';
  }

  private updateConditions(ruleId: string, transform: (root: ConditionGroup) => ConditionGroup, notice: string): void {
    this.updateRules((rule) => rule.id === ruleId
      ? { ...rule, conditions: normalizeConditionGroup(transform(rule.conditions)) }
      : rule, notice);
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
