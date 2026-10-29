/**
 * s07 沿用 s06 的 schema DSL：作者写 TypeScript 结构，运行时编译成 JSON Schema，
 * 同时得到参数类型推导和运行时校验。
 *
 * 真实实现见 `packages/core/tools/src/schema.ts` 与 `json-schema.ts`；
 * 本课保留最常用的 string/number/integer/boolean/null/array/object/json/oneOf。
 */

import type {
  ContentBlock,
  JsonObject,
  JsonValue,
  ToolContext,
  ToolDefinition,
} from './types.ts'

export interface ValueSchemaAnnotations {
  description?: string
  title?: string
  default?: JsonValue
  examples?: JsonValue
}

export interface StringSchema extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
  minLength?: number
  maxLength?: number
}

export interface NumberSchema extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
  minimum?: number
  maximum?: number
}

export interface IntegerSchema extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
  minimum?: number
  maximum?: number
}

export interface BooleanSchema extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

export interface NullSchema extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

export interface ArraySchema extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
  minItems?: number
  maxItems?: number
}

export interface ObjectSchema extends ValueSchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  /** 显式对象必须声明是否允许额外键。 */
  additionalProperties: boolean
}

/** 作者专用的无约束 JSON 节点；编译成空 schema。 */
export interface JsonSchema extends ValueSchemaAnnotations {
  type: 'json'
}

export interface OneOfSchema extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

export type ValueSchemaSpec =
  | StringSchema
  | NumberSchema
  | IntegerSchema
  | BooleanSchema
  | NullSchema
  | ArraySchema
  | ObjectSchema
  | JsonSchema
  | OneOfSchema

/** 隐式参数根对象的每个属性；`required: true` 表示必填。 */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

export type ParameterSchemaSpec = Record<string, ParameterPropertySpec>

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type StringKeyOf<S> = Extract<keyof S, string>

type RequiredKeys<S> = {
  [K in StringKeyOf<S>]: S[K] extends { required: true } ? K : never
}[StringKeyOf<S>]

type InferProperties<S, D extends unknown[]> = Simplify<
  & { [K in RequiredKeys<S>]: InferValueAt<S[K], D> }
  & { [K in Exclude<StringKeyOf<S>, RequiredKeys<S>>]?: InferValueAt<S[K], D> }
>

type InferObject<S extends { additionalProperties: boolean }, D extends unknown[]> =
  S extends { properties: infer P }
    ? S['additionalProperties'] extends true
      ? InferProperties<P, D> & Record<string, JsonValue>
      : InferProperties<P, D>
    : S['additionalProperties'] extends true
      ? Record<string, JsonValue>
      : Record<string, never>

type InferScalar<S, Fallback> =
  S extends { const: infer C } ? C :
    S extends { enum: readonly (infer E)[] } ? E :
      Fallback

type NextDepth<D extends unknown[]> = [unknown, ...D]

type InferValueAt<S, D extends unknown[]> =
  D['length'] extends 16 ? JsonValue :
    S extends { type: 'string' } ? InferScalar<S, string> :
      S extends { type: 'number' | 'integer' } ? InferScalar<S, number> :
        S extends { type: 'boolean' } ? InferScalar<S, boolean> :
          S extends { type: 'null' } ? null :
            S extends { type: 'array' }
              ? S extends { items: infer I } ? InferValueAt<I, NextDepth<D>>[] : JsonValue[]
              : S extends { type: 'object'; additionalProperties: boolean }
                ? InferObject<S, NextDepth<D>>
                : S extends { type: 'json' } ? JsonValue :
                  S extends { oneOf: readonly unknown[] }
                    ? InferValueAt<S['oneOf'][number], NextDepth<D>>
                    : never

export type InferValue<S> = InferValueAt<S, []>
export type InferArgs<S> = InferProperties<S, []>

function copyAnnotations(source: ValueSchemaAnnotations, target: JsonObject): void {
  if (source.description !== undefined) target.description = source.description
  if (source.title !== undefined) target.title = source.title
  if (source.default !== undefined) target.default = source.default
  if (source.examples !== undefined) target.examples = source.examples
}

/** 把一个作者 schema 编译成 JSON Schema。 */
export function valueToJsonSchema(spec: ValueSchemaSpec): JsonObject {
  const target: JsonObject = {}
  copyAnnotations(spec, target)

  if ('oneOf' in spec) {
    target.oneOf = spec.oneOf.map(valueToJsonSchema)
    return target
  }

  switch (spec.type) {
    case 'json':
      return target
    case 'string':
      target.type = 'string'
      if (spec.enum !== undefined) target.enum = [...spec.enum]
      if (spec.const !== undefined) target.const = spec.const
      if (spec.minLength !== undefined) target.minLength = spec.minLength
      if (spec.maxLength !== undefined) target.maxLength = spec.maxLength
      return target
    case 'number':
    case 'integer':
      target.type = spec.type
      if (spec.enum !== undefined) target.enum = [...spec.enum]
      if (spec.const !== undefined) target.const = spec.const
      if (spec.minimum !== undefined) target.minimum = spec.minimum
      if (spec.maximum !== undefined) target.maximum = spec.maximum
      return target
    case 'boolean':
      target.type = 'boolean'
      if (spec.enum !== undefined) target.enum = [...spec.enum]
      if (spec.const !== undefined) target.const = spec.const
      return target
    case 'null':
      target.type = 'null'
      if (spec.enum !== undefined) target.enum = [...spec.enum]
      if (spec.const !== undefined) target.const = spec.const
      return target
    case 'array':
      target.type = 'array'
      if (spec.items !== undefined) target.items = valueToJsonSchema(spec.items)
      if (spec.minItems !== undefined) target.minItems = spec.minItems
      if (spec.maxItems !== undefined) target.maxItems = spec.maxItems
      return target
    case 'object': {
      target.type = 'object'
      target.additionalProperties = spec.additionalProperties
      if (spec.properties !== undefined) {
        target.properties = propertiesToJsonSchema(spec.properties)
        const required = Object.entries(spec.properties)
          .filter(([, property]) => property.required === true)
          .map(([name]) => name)
        if (required.length > 0) target.required = required
      }
      return target
    }
  }
}

function propertiesToJsonSchema(properties: ParameterSchemaSpec): JsonObject {
  const out: JsonObject = {}
  for (const [name, spec] of Object.entries(properties)) {
    out[name] = valueToJsonSchema(spec)
  }
  return out
}

/** 隐式参数根对象：closed，required 由每个属性的 `required: true` 决定。 */
export function parametersToJsonSchema(parameters: ParameterSchemaSpec): JsonObject {
  const schema: JsonObject = {
    type: 'object',
    properties: propertiesToJsonSchema(parameters),
    additionalProperties: false,
  }
  const required = Object.entries(parameters)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
  if (required.length > 0) schema.required = required
  return schema
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateValue(spec: ValueSchemaSpec, value: unknown, path: string, errors: string[]): void {
  if ('oneOf' in spec) {
    const matches = spec.oneOf.filter((branch) => {
      const branchErrors: string[] = []
      validateValue(branch, value, path, branchErrors)
      return branchErrors.length === 0
    })
    if (matches.length !== 1) errors.push(`${path} must match exactly one oneOf branch, matched ${matches.length}`)
    return
  }

  switch (spec.type) {
    case 'json':
      return
    case 'string':
      if (typeof value !== 'string') { errors.push(`${path} must be string, got ${typeName(value)}`); return }
      if (spec.const !== undefined && value !== spec.const) errors.push(`${path} must equal ${JSON.stringify(spec.const)}`)
      if (spec.enum !== undefined && !spec.enum.includes(value)) errors.push(`${path} must be one of ${JSON.stringify(spec.enum)}`)
      if (spec.minLength !== undefined && value.length < spec.minLength) errors.push(`${path} must have length >= ${spec.minLength}`)
      if (spec.maxLength !== undefined && value.length > spec.maxLength) errors.push(`${path} must have length <= ${spec.maxLength}`)
      return
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${path} must be ${spec.type}, got ${typeName(value)}`)
        return
      }
      if (spec.type === 'integer' && !Number.isInteger(value)) errors.push(`${path} must be integer, got ${value}`)
      if (spec.const !== undefined && value !== spec.const) errors.push(`${path} must equal ${spec.const}`)
      if (spec.enum !== undefined && !spec.enum.includes(value)) errors.push(`${path} must be one of ${JSON.stringify(spec.enum)}`)
      if (spec.minimum !== undefined && value < spec.minimum) errors.push(`${path} must be >= ${spec.minimum}`)
      if (spec.maximum !== undefined && value > spec.maximum) errors.push(`${path} must be <= ${spec.maximum}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') { errors.push(`${path} must be boolean, got ${typeName(value)}`); return }
      if (spec.const !== undefined && value !== spec.const) errors.push(`${path} must equal ${spec.const}`)
      if (spec.enum !== undefined && !spec.enum.includes(value)) errors.push(`${path} must be one of ${JSON.stringify(spec.enum)}`)
      return
    case 'null':
      if (value !== null) errors.push(`${path} must be null, got ${typeName(value)}`)
      return
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path} must be array, got ${typeName(value)}`); return }
      if (spec.minItems !== undefined && value.length < spec.minItems) errors.push(`${path} must have at least ${spec.minItems} items`)
      if (spec.maxItems !== undefined && value.length > spec.maxItems) errors.push(`${path} must have at most ${spec.maxItems} items`)
      if (spec.items !== undefined) {
        value.forEach((item, index) => validateValue(spec.items as ValueSchemaSpec, item, `${path}[${index}]`, errors))
      }
      return
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${path} must be object, got ${typeName(value)}`)
        return
      }
      const object = value as Record<string, unknown>
      const properties = spec.properties ?? {}
      for (const [key, property] of Object.entries(properties)) {
        if (!(key in object)) {
          if (property.required === true) errors.push(`${path}.${key} is required`)
          continue
        }
        validateValue(property, object[key], `${path}.${key}`, errors)
      }
      if (!spec.additionalProperties) {
        for (const key of Object.keys(object)) {
          if (!(key in properties)) errors.push(`${path}.${key} is not allowed`)
        }
      }
      return
    }
  }
}

/** 校验工具参数（隐式根对象）。 */
export function validateParameters(parameters: ParameterSchemaSpec, value: unknown): string[] {
  const errors: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['args must be an object']
  }
  const object = value as Record<string, unknown>
  for (const [name, spec] of Object.entries(parameters)) {
    if (!(name in object)) {
      if (spec.required === true) errors.push(`args.${name} is required`)
      continue
    }
    validateValue(spec, object[name], `args.${name}`, errors)
  }
  for (const key of Object.keys(object)) {
    if (!(key in parameters)) errors.push(`args.${key} is not allowed`)
  }
  return errors
}

/** 校验工具返回的规范值。 */
export function validateOutput(schema: ValueSchemaSpec, value: JsonValue): string[] {
  const errors: string[] = []
  validateValue(schema, value, 'value', errors)
  return errors
}

export interface ToolDefinitionInput<
  P extends ParameterSchemaSpec,
  O extends ValueSchemaSpec,
> {
  name: string
  description: string
  parameters: P
  output: {
    schema: O
    render(args: InferArgs<P>, value: InferValue<O>): ContentBlock[]
    presentationMeta?(args: InferArgs<P>, value: InferValue<O>): JsonValue
  }
  execute(args: InferArgs<P>, ctx: ToolContext): Promise<InferValue<O>> | InferValue<O>
  isConcurrencySafe?(args: InferArgs<P>): boolean
}

/** 从 schema DSL 构造注册表使用的 ToolDefinition。 */
export function defineTool<const P extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  input: ToolDefinitionInput<P, O>,
): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    parameters: parametersToJsonSchema(input.parameters),
    output: {
      schema: valueToJsonSchema(input.output.schema),
      render: (args, value) => input.output.render(args as InferArgs<P>, value as InferValue<O>),
      ...input.output.presentationMeta === undefined
        ? {}
        : {
          presentationMeta: (args: unknown, value: JsonValue) =>
            (input.output.presentationMeta as (args: InferArgs<P>, value: InferValue<O>) => JsonValue)(
              args as InferArgs<P>,
              value as InferValue<O>,
            ),
        },
    },
    execute: (args, ctx) => input.execute(args as InferArgs<P>, ctx),
    parameterValidator: (args: unknown) => validateParameters(input.parameters, args),
    outputValidator: (value: JsonValue) => validateOutput(input.output.schema, value),
    ...input.isConcurrencySafe === undefined
      ? {}
      : { isConcurrencySafe: (args: unknown) => input.isConcurrencySafe!(args as InferArgs<P>) },
  }
}
