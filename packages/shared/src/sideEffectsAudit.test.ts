import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Plan 39.1-51 (orchestrator decision 2026-09-26): the committed audit behind
 * `packages/shared/package.json`'s `sideEffects` field.
 *
 * `"sideEffects": false` lets the web's bundler (Rolldown) drop a shared
 * module whose exports nothing uses and move a module into the lazy chunk
 * that uses it. That is only safe when no module does something at import
 * time that another module relies on (a global, a prototype, a zod registry
 * entry, a bare side-effect import). jsdom and vitest never evaluate the
 * built chunks, so the proof is two-part: this file classifies every
 * top-level statement of every non-test module with the TypeScript compiler
 * API, and `pnpm --filter @smash-tracker/web run verify:built-chunks`
 * evaluates the production build in headless Chrome (the PR #181 class).
 *
 * Classes:
 * - pure: declarations, type-only and re-export statements, and initializers
 *   built only from literals, identifiers, property reads, functions,
 *   object / array literals, operators, `Object.freeze`, `new Map` / `new Set`
 *   and zod construction chains (ZOD_CONSTRUCTION_METHODS) over pure values.
 * - review: a top-level loop, `if`, `throw`, a call to anything else, a
 *   template literal with substitutions, any other construction — each module
 *   holding one must be pinned in REVIEWED_TOP_LEVEL_EFFECTS with a verdict.
 * - forbidden: a `globalThis` / `window` / `global` / `self` assignment, a bare
 *   `import './x.js'`, a zod registry call and a prototype mutation. Such a
 *   module may only carry the `side-effect` verdict.
 */

type StatementClass = 'pure' | 'review' | 'forbidden';

interface ClassifiedStatement {
  class: StatementClass;
  /** Stable, line-free signature, e.g. `loop:for-of`, `call:buildIdVocabulary`. */
  signature: string;
  line: number;
}

interface ModuleClassification {
  class: StatementClass;
  statements: ClassifiedStatement[];
}

/**
 * zod construction methods a pure chain may use. Every name here only builds
 * a new schema object from its receiver and arguments; none registers
 * anything globally (zod itself declares `"sideEffects": false`). `.register`,
 * `.meta`, `.describe`, `z.config` and `z.globalRegistry` write zod's global
 * registry and are FORBIDDEN instead (FORBIDDEN_ZOD_MEMBERS).
 */
const ZOD_CONSTRUCTION_METHODS = new Set([
  // The plan's list.
  'object',
  'string',
  'number',
  'boolean',
  'literal',
  'enum',
  'union',
  'discriminatedUnion',
  'array',
  'record',
  'tuple',
  'optional',
  'nullable',
  'nullish',
  'default',
  'extend',
  'merge',
  'pick',
  'omit',
  'partial',
  'required',
  'strict',
  'passthrough',
  'refine',
  'superRefine',
  'transform',
  'pipe',
  'preprocess',
  'min',
  'max',
  'length',
  'regex',
  'int',
  'positive',
  'nonnegative',
  'email',
  'url',
  'uuid',
  'datetime',
  'catch',
  'brand',
  'readonly',
  'lazy',
  'coerce',
  // Found in use in packages/shared/src by this audit (39.1-51 executor); each only builds a schema.
  'trim', // .trim(): a string schema that trims before its checks.
  'unknown', // z.unknown(): a schema accepting any value.
  'null', // z.null(): the null-literal schema.
  'or', // .or(): a two-member union schema.
  'partialRecord', // z.partialRecord(): a record schema whose keys are optional.
]);

/** zod members that write the global registry — forbidden at top level. */
const FORBIDDEN_ZOD_MEMBERS = new Set(['register', 'meta', 'describe', 'globalRegistry']);

const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'global', 'self']);

function peel(expr: ts.Expression): ts.Expression {
  let current = expr;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/** A short, stable name for a callee: `f`, `z.object`, `SpriteList…map`. */
function calleeText(expr: ts.Expression, sf: ts.SourceFile): string {
  const e = peel(expr);
  if (ts.isPropertyAccessExpression(e)) {
    const receiver = peel(e.expression);
    if (ts.isIdentifier(receiver)) return `${receiver.text}.${e.name.text}`;
    return `${chainRoot(receiver) ?? '(expr)'}…${e.name.text}`;
  }
  const text = e.getText(sf).replace(/\s+/g, '');
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function isZodChainCall(call: ts.CallExpression): boolean {
  const callee = peel(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  if (!ZOD_CONSTRUCTION_METHODS.has(callee.name.text)) return false;
  return isZodReceiver(callee.expression);
}

/**
 * The receiver of a zod construction call: `z`, `z.coerce` / `z.iso`, a
 * schema identifier or property read, or another zod construction call.
 */
function isZodReceiver(expr: ts.Expression): boolean {
  const e = peel(expr);
  if (ts.isIdentifier(e)) return true;
  if (ts.isPropertyAccessExpression(e)) {
    if (FORBIDDEN_ZOD_MEMBERS.has(e.name.text)) return false;
    return isZodReceiver(e.expression);
  }
  if (ts.isCallExpression(e)) return isZodChainCall(e) && e.arguments.every(isPureExpression);
  return false;
}

/** True when evaluating `expr` at import time can have no observable effect. */
function isPureExpression(expr: ts.Expression): boolean {
  const e = peel(expr);
  switch (e.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
      return true;
    default:
      break;
  }
  if (ts.isPropertyAccessExpression(e)) {
    if (FORBIDDEN_ZOD_MEMBERS.has(e.name.text)) return false;
    return isPureExpression(e.expression);
  }
  if (ts.isElementAccessExpression(e)) {
    return isPureExpression(e.expression) && isPureExpression(e.argumentExpression);
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((prop) => {
      if (ts.isPropertyAssignment(prop)) {
        const nameOk = ts.isComputedPropertyName(prop.name)
          ? isPureExpression(prop.name.expression)
          : true;
        return nameOk && isPureExpression(prop.initializer);
      }
      if (ts.isShorthandPropertyAssignment(prop)) return true;
      if (ts.isSpreadAssignment(prop)) return isPureExpression(prop.expression);
      // Methods and accessors are deferred code.
      return (
        ts.isMethodDeclaration(prop) ||
        ts.isGetAccessorDeclaration(prop) ||
        ts.isSetAccessorDeclaration(prop)
      );
    });
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.every((el) =>
      ts.isSpreadElement(el) ? isPureExpression(el.expression) : isPureExpression(el),
    );
  }
  if (ts.isPrefixUnaryExpression(e)) {
    if (
      e.operator === ts.SyntaxKind.PlusPlusToken ||
      e.operator === ts.SyntaxKind.MinusMinusToken
    ) {
      return false;
    }
    return isPureExpression(e.operand);
  }
  if (ts.isTypeOfExpression(e) || ts.isVoidExpression(e)) return isPureExpression(e.expression);
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return false;
    return isPureExpression(e.left) && isPureExpression(e.right);
  }
  if (ts.isConditionalExpression(e)) {
    return (
      isPureExpression(e.condition) && isPureExpression(e.whenTrue) && isPureExpression(e.whenFalse)
    );
  }
  if (ts.isCallExpression(e)) {
    const callee = peel(e.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Object' &&
      callee.name.text === 'freeze'
    ) {
      return e.arguments.every(isPureExpression);
    }
    return isZodChainCall(e) && e.arguments.every(isPureExpression);
  }
  if (ts.isNewExpression(e)) {
    const ctor = peel(e.expression);
    if (ts.isIdentifier(ctor) && (ctor.text === 'Map' || ctor.text === 'Set')) {
      return (e.arguments ?? []).every(isPureExpression);
    }
    return false;
  }
  return false;
}

/** Walks the import-time part of a node (never into function / method bodies). */
function walkImportTime(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  if (ts.isFunctionLike(node)) return;
  ts.forEachChild(node, (child) => walkImportTime(child, visit));
}

function rootIdentifier(expr: ts.Expression): string | null {
  let e = peel(expr);
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    e = peel(e.expression);
  }
  return ts.isIdentifier(e) ? e.text : null;
}

/** The identifier a member / call chain starts from: `SpriteList` in `SpriteList.filter(f).map`. */
function chainRoot(expr: ts.Expression): string | null {
  let e = peel(expr);
  while (
    ts.isPropertyAccessExpression(e) ||
    ts.isElementAccessExpression(e) ||
    ts.isCallExpression(e)
  ) {
    e = peel(e.expression);
  }
  return ts.isIdentifier(e) ? e.text : null;
}

function touchesPrototype(expr: ts.Expression, sf: ts.SourceFile): boolean {
  return /(^|\.)prototype(\.|$|\[)/.test(peel(expr).getText(sf));
}

/** The forbidden class found anywhere in a statement's import-time code, if any. */
function findForbidden(node: ts.Node, sf: ts.SourceFile): string | null {
  let found: string | null = null;
  walkImportTime(node, (n) => {
    if (found) return;
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
        const root = rootIdentifier(n.left);
        if (root && GLOBAL_OBJECTS.has(root)) found = 'global-assignment';
        else if (touchesPrototype(n.left, sf)) found = 'prototype-mutation';
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = peel(n.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        const owner = rootIdentifier(callee.expression);
        if (
          owner === 'Object' &&
          (name === 'defineProperty' || name === 'defineProperties' || name === 'assign') &&
          n.arguments[0] &&
          touchesPrototype(n.arguments[0], sf)
        ) {
          found = 'prototype-mutation';
        } else if (name === 'register' || name === 'meta' || name === 'describe') {
          found = 'zod-registry';
        } else if (name === 'config' && ts.isIdentifier(peel(callee.expression)) && owner === 'z') {
          found = 'zod-registry';
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'globalRegistry' &&
      rootIdentifier(n.expression) === 'z'
    ) {
      found = 'zod-registry';
    }
  });
  return found;
}

/** The review kind of an impure expression (the first effect found). */
function reviewKind(expr: ts.Expression, sf: ts.SourceFile): string {
  const e = peel(expr);
  if (ts.isCallExpression(e)) {
    // Inside a zod chain, name the first non-construction link, not the chain head.
    const callee = peel(e.expression);
    if (ts.isPropertyAccessExpression(callee) && ZOD_CONSTRUCTION_METHODS.has(callee.name.text)) {
      if (!isZodReceiver(callee.expression)) return reviewKind(callee.expression, sf);
      const impure = e.arguments.find((arg) => !isPureExpression(arg));
      if (impure) return reviewKind(impure, sf);
    }
    return `call:${calleeText(e.expression, sf)}`;
  }
  if (ts.isTaggedTemplateExpression(e)) return `call:${calleeText(e.tag, sf)}`;
  if (ts.isTemplateExpression(e)) return 'template-substitution';
  if (ts.isNewExpression(e)) return `construct:${calleeText(e.expression, sf)}`;
  return firstImpure(e, sf) ?? `expression:${ts.SyntaxKind[e.kind]}`;
}

/** The review kind of the first impure sub-expression (object members and spreads included). */
function firstImpure(node: ts.Node, sf: ts.SourceFile): string | null {
  let inner: string | null = null;
  ts.forEachChild(node, (child) => {
    if (inner || ts.isFunctionLike(child)) return;
    if (ts.isExpression(child)) {
      if (!isPureExpression(child)) inner = reviewKind(child, sf);
      return;
    }
    inner = firstImpure(child, sf);
  });
  return inner;
}

function containsThrow(node: ts.Node): boolean {
  let found = false;
  walkImportTime(node, (n) => {
    if (ts.isThrowStatement(n)) found = true;
  });
  return found;
}

function classifyStatement(stmt: ts.Statement, sf: ts.SourceFile): ClassifiedStatement[] {
  const line = sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1;
  const forbidden = findForbidden(stmt, sf);
  if (forbidden) return [{ class: 'forbidden', signature: forbidden, line }];

  if (ts.isImportDeclaration(stmt)) {
    if (!stmt.importClause) return [{ class: 'forbidden', signature: 'bare-import', line }];
    return [{ class: 'pure', signature: 'import', line }];
  }
  if (
    ts.isExportDeclaration(stmt) ||
    ts.isFunctionDeclaration(stmt) ||
    ts.isInterfaceDeclaration(stmt) ||
    ts.isTypeAliasDeclaration(stmt) ||
    ts.isImportEqualsDeclaration(stmt) ||
    ts.isModuleDeclaration(stmt) ||
    ts.isEmptyStatement(stmt)
  ) {
    return [{ class: 'pure', signature: ts.SyntaxKind[stmt.kind], line }];
  }
  if (ts.isClassDeclaration(stmt)) {
    const effectful = stmt.members.some(
      (m) =>
        ts.isClassStaticBlockDeclaration(m) ||
        (ts.isPropertyDeclaration(m) &&
          m.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword) &&
          m.initializer !== undefined &&
          !isPureExpression(m.initializer)),
    );
    const name = stmt.name?.text ?? 'default';
    return [
      effectful
        ? { class: 'review', signature: `class-static:${name}`, line }
        : { class: 'pure', signature: 'ClassDeclaration', line },
    ];
  }
  if (ts.isEnumDeclaration(stmt)) {
    const pure = stmt.members.every((m) => !m.initializer || isPureExpression(m.initializer));
    return [
      pure
        ? { class: 'pure', signature: 'EnumDeclaration', line }
        : { class: 'review', signature: `enum:${stmt.name.text}`, line },
    ];
  }
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.map((decl) => {
      const name = decl.name.getText(sf);
      if (!decl.initializer || isPureExpression(decl.initializer)) {
        return { class: 'pure' as const, signature: `const:${name}`, line };
      }
      return {
        class: 'review' as const,
        signature: `${reviewKind(decl.initializer, sf)}@${name}`,
        line,
      };
    });
  }
  if (ts.isExportAssignment(stmt)) {
    return [
      isPureExpression(stmt.expression)
        ? { class: 'pure', signature: 'export-default', line }
        : { class: 'review', signature: `${reviewKind(stmt.expression, sf)}@default`, line },
    ];
  }
  if (ts.isExpressionStatement(stmt)) {
    return [
      isPureExpression(stmt.expression)
        ? { class: 'pure', signature: 'expression', line }
        : { class: 'review', signature: reviewKind(stmt.expression, sf), line },
    ];
  }
  if (
    ts.isForStatement(stmt) ||
    ts.isForOfStatement(stmt) ||
    ts.isForInStatement(stmt) ||
    ts.isWhileStatement(stmt) ||
    ts.isDoStatement(stmt)
  ) {
    const kind = ts.isForOfStatement(stmt)
      ? 'for-of'
      : ts.isForInStatement(stmt)
        ? 'for-in'
        : ts.isForStatement(stmt)
          ? 'for'
          : 'while';
    return [{ class: 'review', signature: `loop:${kind}`, line }];
  }
  if (ts.isIfStatement(stmt)) {
    return [{ class: 'review', signature: containsThrow(stmt) ? 'invariant-throw' : 'if', line }];
  }
  if (ts.isThrowStatement(stmt)) return [{ class: 'review', signature: 'throw', line }];
  return [{ class: 'review', signature: `statement:${ts.SyntaxKind[stmt.kind]}`, line }];
}

const RANK: Record<StatementClass, number> = { pure: 0, review: 1, forbidden: 2 };

/** Classifies every top-level statement of one module's source. */
export function classifyTopLevel(source: string, fileName: string): ModuleClassification {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const statements = sf.statements.flatMap((stmt) => classifyStatement(stmt, sf));
  const worst = statements.reduce<StatementClass>(
    (acc, s) => (RANK[s.class] > RANK[acc] ? s.class : acc),
    'pure',
  );
  return { class: worst, statements };
}

type Verdict = 'module-local' | 'invariant' | 'unreachable' | 'side-effect';

interface ReviewedModule {
  verdict: Verdict;
  /** The sorted non-pure statement signatures this review covers — a new one fails. */
  statements: string[];
  reason: string;
}

/**
 * Every non-test module under `src/` with a review- or forbidden-class
 * top-level statement, filled from the classifier's own output (39.1-51) and
 * reviewed by hand. Verdicts:
 * - module-local: the statement only builds or fills this module's own
 *   constants from its own or imported pure values; nothing outside the
 *   module observes it except through the module's exports.
 * - invariant: a top-level check that throws only when this module's own
 *   constants are inconsistent; dropping an unused module drops a check that
 *   guards nothing.
 * - unreachable: no other src module imports the file (proven below).
 * - side-effect: another module relies on the effect; listed in
 *   package.json's `sideEffects` array.
 */
const REVIEWED_TOP_LEVEL_EFFECTS: Record<string, ReviewedModule> = {
  'billing.ts': {
    verdict: 'module-local',
    statements: ['call:CREDIT_PACKS.map@creditPackIdSchema'],
    reason:
      "z.enum over CREDIT_PACKS.map(...): builds this module's own schema from its own constant.",
  },
  'evidence/adversarialFixtures.ts': {
    verdict: 'unreachable',
    statements: [
      'call:()=>{constsubject:ClaimSubject={...NU...@unknownBucketInDenominator',
      'call:()=>{constsubject:ClaimSubject={...NU...@unknownBucketNamedAsRealStage',
      'call:(expr)…join@ORDINARY_PROSE_NUMERIC_IDIOM_TEXT',
      'call:(expr)…join@ORDINARY_PROSE_TEXT',
      'call:(expr)…map@tierBoundaryFixtures',
      'call:D24_R5_RECORD_PHRASINGS.map@d24R5Fixtures',
      'call:D24_R6_RECORD_PHRASINGS.map@d24R6Fixtures',
      'call:D24_R7_RECORD_PHRASINGS.map@d24R7Fixtures',
      'call:D24_R8_RECORD_PHRASINGS.map@d24R8Fixtures',
      'call:D24_RECORD_PHRASINGS.map@d24RecordFixtures',
      'call:D24_TIER_PHRASINGS.map@d24TierFixtures',
      'call:evidenceIdFor@ACTION_UNLINKED_ROW_ID',
      'call:evidenceIdFor@ALL_NULL_SUBJECT_COHORT_ROW_ID',
      'call:evidenceIdFor@ALL_NULL_SUBJECT_MY_CHARACTER_ROW_ID',
      'call:evidenceIdFor@ALL_NULL_SUBJECT_ORDINARY_ROW_ID',
      'call:evidenceIdFor@ALL_NULL_SUBJECT_RECENT_FORM_ROW_ID',
      'call:evidenceIdFor@CITATION_MISSING_REAL_ROW_ID',
      'call:evidenceIdFor@D24_MIXED_TIER_HIGH_ROW_ID',
      'call:evidenceIdFor@D24_MIXED_TIER_LOW_ROW_ID',
      'call:evidenceIdFor@ORDINARY_PROSE_ROW_ID',
      'call:evidenceIdFor@PROSE_ENCODING_FULLWIDTH_ROW_ID',
      'call:evidenceIdFor@PROSE_ENCODING_JA_ROW_ID',
      'call:evidenceIdFor@PROSE_ENCODING_NFD_ROW_ID',
      'call:evidenceIdFor@PROSE_ENTITY_DIGIT_TAG_ROW_ID',
      'call:evidenceIdFor@PROSE_ENTITY_ROW_ID',
      'call:evidenceIdFor@SUB_FLOOR_ROW_ID',
      'call:evidenceIdFor@UNISSUED_ROW_ID',
      'call:evidenceIdFor@WELL_FORMED_ROW_ID',
      'call:evidenceIdFor@WRONG_VALUE_ROW_ID',
      'call:makeConfidenceWordFixture@confidenceWordHedgeOnHighTier',
      'call:makeConfidenceWordFixture@confidenceWordStrengthOnLowTier',
      'call:makeConfidenceWordFixture@confidenceWordTierAfterBareQuestion',
      'call:makeConfidenceWordFixture@confidenceWordTierAfterDash',
      'call:makeConfidenceWordFixture@confidenceWordTierAfterExclamation',
      'call:makeConfidenceWordFixture@confidenceWordTierAfterNewline',
      'call:makeConfidenceWordFixture@confidenceWordTierAfterNoun',
      'call:makeConfidenceWordFixture@confidenceWordTierAfterQuestion',
      'call:makeConfidenceWordFixture@confidenceWordTierAfterSemicolon',
      'call:makeConfidenceWordFixture@confidenceWordTierEndOfSentence',
      'call:makeConfidenceWordFixture@confidenceWordTierInParenthetical',
      'call:makeConfidenceWordFixture@confidenceWordUnlicensedWord',
      'call:makeProseEntityPerspectiveFixture@d24QualitativeControlTag',
      'call:makeProseEntityPerspectiveFixture@proseEntityPerspectiveOpponentSubjectReversed',
      'call:makeProseEntityPerspectiveFixture@proseEntityPerspectiveOpponentSubjectUnreversed',
      'call:makeProseEntityPerspectiveFixture@proseEntityPerspectiveSplitQuestion',
      'call:makeProseEntityPerspectiveFixture@proseEntityPerspectiveUserClauseSit',
      'call:makeProseEntityPerspectiveFixture@proseEntityPerspectiveUserClauseTough',
      'call:makeProseEntityPerspectiveFixture@proseEntityPerspectiveUserClauseTrail',
      'call:makeProseEntitySnapshot@proseEntityLicensedDifferentSection',
      'call:makeProseEntitySnapshot@proseEntityStageNameMismatch',
      'call:makeProseEntitySnapshot@proseEntityUnlicensedSameSection',
      'call:makeSnapshot@actionUnlinked',
      'call:makeSnapshot@allNullSubject',
      'call:makeSnapshot@coldStartEmptySnapshot',
      'call:makeSnapshot@d24MixedTierUnion',
      'call:makeSnapshot@d24QualitativeControls',
      'call:makeSnapshot@missingEvidenceId',
      'call:makeSnapshot@ordinaryProse',
      'call:makeSnapshot@ordinaryProseNumericIdiom',
      'call:makeSnapshot@proseEncodingFullwidthDigit',
      'call:makeSnapshot@proseEncodingJaLocale',
      'call:makeSnapshot@proseEncodingNfdOpponentTag',
      'call:makeSnapshot@proseEntityDigitBearingTag',
      'call:makeSnapshot@subFloor',
      'call:makeSnapshot@unissuedClaimId',
      'call:makeSnapshot@wellFormed',
      'call:makeSnapshot@wrongValueWithRealId',
      'call:makeSparseCountFixture@coldStartOneGame',
      'call:makeSparseCountFixture@coldStartTwoGame',
      'call:unknownCharacterOnlyWorkspace@UNKNOWN_BUCKET_NAMED_WINS',
      'call:unknownStageOnlyWorkspace@UNKNOWN_BUCKET_DENOMINATOR_UNKNOWN_COUNT',
      'template-substitution@D24_R5_RECORD_PHRASINGS',
      'template-substitution@D24_R6_CONTROL_PHRASINGS',
      'template-substitution@D24_R6_RECORD_PHRASINGS',
      'template-substitution@D24_R7_CONTROL_PHRASINGS',
      'template-substitution@D24_R7_RECORD_PHRASINGS',
      'template-substitution@D24_R8_CONTROL_PHRASINGS',
      'template-substitution@D24_R8_RECORD_PHRASINGS',
      'template-substitution@D24_RECORD_PHRASINGS',
      'template-substitution@unknownBucketNamedPlural',
    ],
    reason:
      'The RPT-08 test-only fixture corpus: every call builds a deterministic, module-private fixture object (evidenceIdFor / makeSnapshot / workspace builders, template strings) from static inputs; no src module imports it (proven below), only *.test.ts files.',
  },
  'evidence/claims.ts': {
    verdict: 'module-local',
    statements: [
      'call:buildIdVocabulary@ACTION_ID_VOCABULARY',
      'call:buildIdVocabulary@CLAIM_ID_VOCABULARY',
    ],
    reason:
      "buildIdVocabulary() (marked @__PURE__) freezes a fresh c01..c32 / a01..a09 array for this module's own exported vocabularies.",
  },
  'evidence/confidencePhrases.ts': {
    verdict: 'module-local',
    statements: ['template-substitution@CONFIDENCE_TIER_KEYS'],
    reason:
      "The template literals only build this module's own exported i18n key strings from its own SAMPLE_CUE_KEY constant.",
  },
  'evidence/evidence.bench.ts': {
    verdict: 'unreachable',
    statements: [
      'call:describe',
      'call:generateSyntheticMatches@eightK',
      'call:generateSyntheticMatches@fiftyK',
      'call:mainCharacterScope@eightKCharacterScope',
    ],
    reason:
      'A vitest bench file (registers a describe at import); compiled to dist but imported by no module, so no bundle ever includes it.',
  },
  'evidence/predicate.ts': {
    verdict: 'module-local',
    statements: ['construct:Set@KNOWN_FIGHTER_IDS'],
    reason:
      'new Set(SpriteList.map(...)): a module-private lookup set built from imported static data.',
  },
  'evidence/validateReport.ts': {
    verdict: 'module-local',
    statements: [
      'call:Object.freeze@ALL_CANONICAL_NAMES',
      'call:Object.freeze@AMBIGUOUS_ENTITY_NAMES',
      'call:Object.freeze@CANONICAL_ENTITY_NAMES',
      'construct:Map@FIGHTER_NAME_BY_ID',
      'construct:Map@STAGE_NAME_BY_ID',
      'construct:RegExp@FIGURE_PHRASE_PATTERN',
      'construct:RegExp@FIGURE_TOKEN',
      'construct:RegExp@FIGURE_WORD_PATTERN',
      'construct:RegExp@NAME_COUNT_FOLLOWER',
      'construct:Set@TIER_FORMS',
      'template-substitution@CONSUMED_SPAN_PLACEHOLDER',
    ],
    reason:
      'new Map / Set / RegExp, Object.freeze and a template string build module-private lookup tables, the exported AMBIGUOUS_ENTITY_NAMES list and non-global (no lastIndex state) patterns from imported static SpriteList / StageList data and its own constants.',
  },
  'fighterData.ts': {
    verdict: 'module-local',
    statements: ['loop:for-of'],
    reason:
      "The for-of loop fills this module's own exported spritesById Map from its own SpriteList; other modules see it only through the export.",
  },
  'gspMmr.ts': {
    verdict: 'module-local',
    statements: ['call:Date.UTC@GSP_MODEL', 'call:mmrPointsForWin@ASSUMED_MMR_POINTS_PER_MATCH'],
    reason:
      "Date.UTC (a pure number) and mmrPointsForWin(0) (a table lookup) compute this module's own constants.",
  },
  'insight/templates/characterMovers.ts': {
    verdict: 'module-local',
    statements: ['construct:Map@FIGHTER_NAME_BY_ID'],
    reason:
      'new Map(SpriteList.map(...)): a module-private name lookup built from imported static data.',
  },
  'insight/templates/nullFixtures.ts': {
    verdict: 'module-local',
    statements: ['call:SpriteList…map@OPPONENT_FIGHTER_POOL'],
    reason:
      'SpriteList.filter(...).map(...): a module-private id pool built from imported static data.',
  },
  'liquipediaCharacterMap.ts': {
    verdict: 'module-local',
    statements: ['call:buildLookup@liquipediaCharacterToFighterId'],
    reason:
      "buildLookup() builds this module's exported Map from its own tables (it throws only when those tables are inconsistent).",
  },
  'researchEnrichment.ts': {
    verdict: 'invariant',
    statements: [
      'invariant-throw',
      'invariant-throw',
      'template-substitution@researchEnrichmentCoverageSnapshotSchema',
    ],
    reason:
      "Two if-throw checks that its provider / content-type constants are subsets of researchProvenance's; the template only builds a schema message string.",
  },
  'researchIngestion.ts': {
    verdict: 'module-local',
    statements: [
      'template-substitution@researchCoverageSnapshotSchema',
      'template-substitution@researchIdentityMappingSchema',
      'template-substitution@researchTenantIngestionStateSchema',
    ],
    reason: "The templates only build validation-message strings inside this module's own schemas.",
  },
  'ruleset.ts': {
    verdict: 'module-local',
    statements: [
      'call:COUNTERPICK_STAGE_NAMES…sort@DEFAULT_COUNTERPICK_STAGE_IDS',
      'call:STARTER_STAGE_NAMES…sort@DEFAULT_STARTER_STAGE_IDS',
    ],
    reason:
      'map(stageIdForLegalStageName).sort() on fresh arrays builds module-private id lists (the lookup throws only on a drifted stage table).',
  },
  'stageData.ts': {
    verdict: 'module-local',
    statements: ['loop:for-of'],
    reason:
      "The for-of loop fills this module's own exported stagesById Map from its own StageList; other modules see it only through the export.",
  },
  'testUtils/syntheticMatches.ts': {
    verdict: 'module-local',
    statements: ['call:SpriteList.map@ALL_FIGHTER_IDS', 'call:StageList.map@ALL_KNOWN_STAGES'],
    reason:
      'SpriteList.map / StageList.map build module-private id lists for the fixture generator.',
  },
};

const SRC_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = path.resolve(SRC_ROOT, '..', 'package.json');

function listModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listModules(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out.sort();
}

function relModule(full: string): string {
  return path.relative(SRC_ROOT, full).split(path.sep).join('/');
}

/** Relative module specifiers of every import / re-export statement of a module. */
function importedModules(full: string): string[] {
  const source = fs.readFileSync(full, 'utf8');
  const sf = ts.createSourceFile(full, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const stmt of sf.statements) {
    const spec =
      (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : null;
    if (!spec || !spec.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(full), spec.replace(/\.js$/, ''));
    const candidates = [`${resolved}.ts`, path.join(resolved, 'index.ts')];
    const hit = candidates.find((c) => fs.existsSync(c));
    if (hit) out.push(relModule(hit));
  }
  return out;
}

function nonPureSignatures(c: ModuleClassification): string[] {
  return c.statements
    .filter((s) => s.class !== 'pure')
    .map((s) => s.signature)
    .sort();
}

describe('side-effects audit: classifier fixtures', () => {
  const cls = (src: string) => classifyTopLevel(src, 'fixture.ts');

  it('side-effects audit: a zod construction chain is pure', () => {
    expect(
      cls(`import { z } from 'zod';\nexport const s = z.object({ a: z.string() }).strict();`).class,
    ).toBe('pure');
  });

  it('side-effects audit: Object.freeze of a literal is pure', () => {
    expect(cls(`export const A = Object.freeze(['a', 'b'] as const);`).class).toBe('pure');
  });

  it('side-effects audit: new Map / new Set of literals is pure', () => {
    expect(cls(`const m = new Map([[1, 'a']]);\nconst s = new Set(['x']);`).class).toBe('pure');
  });

  it('side-effects audit: declarations, type-only imports and export * re-exports are pure', () => {
    const src = [
      `import type { X } from './x.js';`,
      `import { y } from './y.js';`,
      `export * from './z.js';`,
      `export function f() { globalThis.leak = 1; return y; }`,
      `export class C { m() { return 1; } }`,
      `export interface I { a: X }`,
      `export type T = string;`,
    ].join('\n');
    expect(cls(src).class).toBe('pure');
  });

  it('side-effects audit: a module-local Map filled by a top-level for loop needs review', () => {
    const r = cls(`export const m = new Map();\nfor (const x of [1]) { m.set(x, x); }`);
    expect(r.class).toBe('review');
    expect(nonPureSignatures(r)).toEqual(['loop:for-of']);
  });

  it('side-effects audit: a top-level if (...) throw needs review', () => {
    const r = cls(`const A = [1];\nif (!A.every((a) => a > 0)) { throw new Error('bad'); }`);
    expect(r.class).toBe('review');
    expect(nonPureSignatures(r)).toEqual(['invariant-throw']);
  });

  it('side-effects audit: a call to a builder function needs review', () => {
    const r = cls(`function build() { return 1; }\nexport const V = build();`);
    expect(r.class).toBe('review');
    expect(nonPureSignatures(r)).toEqual(['call:build@V']);
  });

  it('side-effects audit: a top-level template literal with substitutions needs review', () => {
    const r = cls('const N = 4;\nexport const P = `^x{${N}}$`;');
    expect(r.class).toBe('review');
    expect(nonPureSignatures(r)).toEqual(['template-substitution@P']);
  });

  it('side-effects audit: a globalThis / window assignment is forbidden', () => {
    expect(cls(`globalThis.x = 1;`).class).toBe('forbidden');
    expect(cls(`(window as any).y = 2;`).class).toBe('forbidden');
    expect(nonPureSignatures(cls(`globalThis.x = 1;`))).toEqual(['global-assignment']);
  });

  it("side-effects audit: a bare import './x.js' is forbidden", () => {
    const r = cls(`import './x.js';`);
    expect(r.class).toBe('forbidden');
    expect(nonPureSignatures(r)).toEqual(['bare-import']);
  });

  it('side-effects audit: a zod registry call is forbidden', () => {
    for (const src of [
      `import { z } from 'zod';\nexport const s = z.string().register(reg, {});`,
      `import { z } from 'zod';\nexport const s = z.string().meta({ id: 'x' });`,
      `import { z } from 'zod';\nexport const s = z.string().describe('x');`,
      `import { z } from 'zod';\nz.config({});`,
      `import { z } from 'zod';\nconst r = z.globalRegistry;`,
    ]) {
      const r = cls(src);
      expect(r.class, src).toBe('forbidden');
      expect(nonPureSignatures(r), src).toEqual(['zod-registry']);
    }
  });

  it('side-effects audit: Object.defineProperty on a prototype is forbidden', () => {
    const r = cls(`Object.defineProperty(Array.prototype, 'x', { value: 1 });`);
    expect(r.class).toBe('forbidden');
    expect(nonPureSignatures(r)).toEqual(['prototype-mutation']);
    expect(cls(`String.prototype.y = () => 1;`).class).toBe('forbidden');
  });
});

describe('side-effects audit: the packages/shared/src tree', () => {
  const modules = listModules(SRC_ROOT);
  const classified = new Map(
    modules.map((full) => [relModule(full), classifyTopLevel(fs.readFileSync(full, 'utf8'), full)]),
  );

  it('side-effects audit: every non-pure module is pinned in REVIEWED_TOP_LEVEL_EFFECTS with its exact statements', () => {
    expect(modules.length).toBeGreaterThan(90);
    const flagged = [...classified.entries()]
      .filter(([, c]) => c.class !== 'pure')
      .map(([m]) => m)
      .sort();
    expect(flagged, 'modules with review / forbidden top-level statements').toEqual(
      Object.keys(REVIEWED_TOP_LEVEL_EFFECTS).sort(),
    );
    for (const [module, review] of Object.entries(REVIEWED_TOP_LEVEL_EFFECTS)) {
      const c = classified.get(module);
      expect(c, module).toBeDefined();
      expect(nonPureSignatures(c!), `${module}: reviewed statements`).toEqual(
        [...review.statements].sort(),
      );
      expect(review.reason.trim().length, `${module}: reason`).toBeGreaterThan(10);
      if (c!.class === 'forbidden') {
        expect(review.verdict, `${module}: forbidden-class module`).toBe('side-effect');
      }
    }
  });

  it('side-effects audit: every unreachable verdict is proven — no other src module imports the file', () => {
    const importers = new Map<string, string[]>();
    for (const full of modules) {
      for (const target of importedModules(full)) {
        importers.set(target, [...(importers.get(target) ?? []), relModule(full)]);
      }
    }
    for (const [module, review] of Object.entries(REVIEWED_TOP_LEVEL_EFFECTS)) {
      if (review.verdict !== 'unreachable') continue;
      const by = (importers.get(module) ?? []).filter((m) => m !== module);
      expect(by, `${module} is imported by`).toEqual([]);
    }
  });

  it('side-effects audit: package.json sideEffects equals the audit (false, or the sorted dist paths of side-effect verdicts)', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as { sideEffects?: unknown };
    const effectful = Object.entries(REVIEWED_TOP_LEVEL_EFFECTS)
      .filter(([, review]) => review.verdict === 'side-effect')
      .map(([module]) => `./dist/${module.replace(/\.ts$/, '.js')}`)
      .sort();
    expect(pkg.sideEffects).toEqual(effectful.length === 0 ? false : effectful);
  });
});
