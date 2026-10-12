import ts from 'typescript'

type Entry = [signature: string, description: string]
const parse = (code: string, path: string) =>
  ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

function description(node: ts.Node, file: ts.SourceFile): string {
  const comment = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc).at(-1)?.comment
  const text = typeof comment === 'string' ? comment.trim() : ''
  const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
  if (!text) throw new Error(`接口手册缺少用途说明：${file.fileName}:${line}`)
  return `${text}（${file.fileName}:${line}）`
}

function callable(
  node: ts.Node,
): node is ts.ArrowFunction | ts.FunctionDeclaration | ts.MethodDeclaration {
  return ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
}

function signature(name: string, node?: ts.Node): string {
  return node && callable(node)
    ? `${name}(${node.parameters.map((parameter) => parameter.name.getText()).join(', ')})`
    : name
}

function members(object: ts.ObjectLiteralExpression, file: ts.SourceFile, prefix: string): Entry[] {
  return object.properties.map((property): Entry => {
    if (ts.isSpreadAssignment(property) || !property.name)
      throw new Error(`接口手册不能静态解析展开成员：${file.fileName}`)
    let implementation: ts.Node | undefined = ts.isPropertyAssignment(property)
      ? property.initializer
      : property
    if (ts.isShorthandPropertyAssignment(property)) {
      // The public bridge exposes invoke by shorthand; parameters belong to its declaration.
      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && node.name.getText(file) === property.name.text)
          implementation = node.initializer
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    return [
      signature(`${prefix}${property.name.getText(file)}`, implementation),
      description(property, file),
    ]
  })
}

/** Read public members from their implementation, never a separately maintained method list. */
export function createVueReference(helper: string, bridge: string, types: string): Entry[] {
  const helperFile = parse(helper, 'Page.js')
  const usePage = helperFile.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'usePage',
  )
  const returned = usePage?.body?.statements.filter(ts.isReturnStatement).at(-1)?.expression
  if (!usePage || !returned || !ts.isObjectLiteralExpression(returned))
    throw new Error('接口手册无法定位 usePage 的公开返回对象')
  const result: Entry[] = [[signature('usePage', usePage), description(usePage, helperFile)]]
  result.push(...members(returned, helperFile, 'page.'))
  const region = usePage
    .body!.statements.flatMap((statement) =>
      ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
    )
    .find((node) => node.name.getText(helperFile) === 'Region')?.initializer
  const component = region && ts.isCallExpression(region) ? region.arguments[0] : undefined
  const props =
    component && ts.isObjectLiteralExpression(component)
      ? component.properties.find(
          (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) && node.name.getText(helperFile) === 'props',
        )?.initializer
      : undefined
  if (!props || !ts.isObjectLiteralExpression(props))
    throw new Error('接口手册无法读取 Region 的属性')
  result.push(...members(props, helperFile, 'page.Region.'))
  const nodes = returned.properties.find(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText(helperFile) === 'nodes',
  )?.initializer
  if (nodes) {
    const findResult = (node: ts.Node) => {
      if (
        ts.isArrowFunction(node) &&
        ts.isParenthesizedExpression(node.body) &&
        ts.isObjectLiteralExpression(node.body.expression)
      )
        result.push(...members(node.body.expression, helperFile, 'page.nodes()[].'))
      ts.forEachChild(node, findResult)
    }
    findResult(nodes)
  }

  const bridgeFile = parse(bridge, 'src/services/UiViewRuntime.ts')
  let bridgeObject: ts.ObjectLiteralExpression | undefined
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(bridgeFile) === 'Object.defineProperty' &&
      node.arguments[0]?.getText(bridgeFile) === 'window' &&
      node.arguments[1] &&
      ts.isStringLiteral(node.arguments[1]) &&
      node.arguments[1].text === 'srlUi'
    ) {
      const descriptor = node.arguments[2]
      if (descriptor && ts.isObjectLiteralExpression(descriptor)) {
        const value = descriptor.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText(bridgeFile) === 'value',
        )?.initializer
        if (
          value &&
          ts.isCallExpression(value) &&
          value.expression.getText(bridgeFile) === 'Object.freeze'
        ) {
          const object = value.arguments[0]
          if (object && ts.isObjectLiteralExpression(object)) bridgeObject = object
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(bridgeFile)
  if (!bridgeObject) throw new Error('接口手册无法定位 window.srlUi 的公开接口')
  result.push(...members(bridgeObject, bridgeFile, 'window.srlUi.'))

  const typeFile = parse(types, 'src/types/UiCustomization.ts')
  for (const name of ['UiViewSnapshot', 'UiControl', 'UiViewAction']) {
    const schema = typeFile.statements.find(
      (node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === name,
    )
    if (!schema) throw new Error(`接口手册缺少公开类型：${name}`)
    for (const field of schema.members) {
      if (!ts.isPropertySignature(field) || !field.type)
        throw new Error(`接口手册不能解析类型成员：${name}`)
      result.push([
        `${name}.${field.name.getText(typeFile)}${field.questionToken ? '?' : ''}: ${field.type.getText(typeFile)}`,
        description(field, typeFile),
      ])
    }
  }
  return result
}
