// Gera código Lua 5.1 a partir da AST produzida por luaparse.

function quoteLuaString(value) {
    const escapes = {
        '\\': '\\\\',
        '"': '\\"',
        '\n': '\\n',
        '\r': '\\r',
        '\t': '\\t',
        '\b': '\\b',
        '\f': '\\f',
    };
    const escaped = value.replace(/[\u0000-\u001f\u007f\\"]/g, character => {
        if (escapes[character]) return escapes[character];
        return `\\${character.charCodeAt(0).toString().padStart(3, '0')}`;
    });
    return `"${escaped}"`;
}

function generatePrefix(node) {
    const expression = generateNode(node);
    if (['Identifier', 'MemberExpression', 'IndexExpression', 'CallExpression',
        'TableCallExpression', 'StringCallExpression'].includes(node.type)) {
        return expression;
    }
    return `(${expression})`;
}

function generateNode(node, indent = '') {
    if (Array.isArray(node)) {
        return node.map(statement => generateNode(statement, indent)).join('\n');
    }
    if (!node || typeof node !== 'object') {
        throw new TypeError('Expected a luaparse AST node');
    }

    switch (node.type) {
        case 'Chunk':
            return generateNode(node.body, indent);

        case 'LocalStatement': {
            const variables = node.variables.map(variable => generateNode(variable)).join(', ');
            const initializers = node.init.map(value => generateNode(value)).join(', ');
            return `${indent}local ${variables}${node.init.length ? ` = ${initializers}` : ''}`;
        }

        case 'AssignmentStatement': {
            const variables = node.variables.map(variable => generateNode(variable)).join(', ');
            const initializers = node.init.map(value => generateNode(value)).join(', ');
            return `${indent}${variables} = ${initializers}`;
        }

        case 'CallStatement':
            return indent + generateNode(node.expression);

        case 'FunctionDeclaration': {
            const parameters = node.parameters.map(parameter => generateNode(parameter)).join(', ');
            const prefix = node.isLocal ? 'local ' : '';
            const name = node.identifier ? ` ${generateNode(node.identifier)}` : '';
            const body = generateNode(node.body, indent + '    ');
            return `${indent}${prefix}function${name}(${parameters})\n${body}\n${indent}end`;
        }

        case 'ReturnStatement': {
            const args = node.arguments.map(argument => generateNode(argument)).join(', ');
            return `${indent}return${node.arguments.length ? ` ${args}` : ''}`;
        }

        case 'IfStatement': {
            if (!Array.isArray(node.clauses) || node.clauses.length === 0) {
                throw new Error('IfStatement must contain at least one clause');
            }

            let result = '';
            node.clauses.forEach((clause, index) => {
                if (clause.type === 'IfClause' && index === 0) {
                    result += `${indent}if ${generateNode(clause.condition)} then`;
                } else if (clause.type === 'ElseifClause') {
                    result += `\n${indent}elseif ${generateNode(clause.condition)} then`;
                } else if (clause.type === 'ElseClause') {
                    result += `\n${indent}else`;
                } else {
                    throw new Error(`Unhandled if clause: ${clause.type}`);
                }

                const body = generateNode(clause.body, indent + '    ');
                if (body) result += `\n${body}`;
            });
            return `${result}\n${indent}end`;
        }

        case 'WhileStatement': {
            const body = generateNode(node.body, indent + '    ');
            return `${indent}while ${generateNode(node.condition)} do\n${body}\n${indent}end`;
        }

        case 'RepeatStatement': {
            const body = generateNode(node.body, indent + '    ');
            return `${indent}repeat\n${body}\n${indent}until ${generateNode(node.condition)}`;
        }

        case 'ForNumericStatement': {
            const step = node.step ? `, ${generateNode(node.step)}` : '';
            const body = generateNode(node.body, indent + '    ');
            return `${indent}for ${generateNode(node.variable)} = ${generateNode(node.start)}, ` +
                `${generateNode(node.end)}${step} do\n${body}\n${indent}end`;
        }

        case 'ForGenericStatement': {
            const variables = node.variables.map(variable => generateNode(variable)).join(', ');
            const iterators = node.iterators.map(iterator => generateNode(iterator)).join(', ');
            const body = generateNode(node.body, indent + '    ');
            return `${indent}for ${variables} in ${iterators} do\n${body}\n${indent}end`;
        }

        case 'DoStatement': {
            const body = generateNode(node.body, indent + '    ');
            return `${indent}do\n${body}\n${indent}end`;
        }

        case 'BreakStatement':
            return `${indent}break`;

        case 'CallExpression':
            return `${generatePrefix(node.base)}(${node.arguments.map(argument => generateNode(argument)).join(', ')})`;

        case 'TableCallExpression':
            return `${generatePrefix(node.base)} ${generateNode(node.arguments)}`;

        case 'StringCallExpression':
            return `${generatePrefix(node.base)} ${generateNode(node.argument)}`;

        case 'Identifier':
            return node.name;

        case 'NumericLiteral':
        case 'BooleanLiteral':
            return node.raw || String(node.value);

        case 'StringLiteral':
            return node.raw || quoteLuaString(String(node.value));

        case 'NilLiteral':
            return node.raw || 'nil';

        case 'VarargLiteral':
            return node.raw || '...';

        case 'TableConstructorExpression':
            return `{ ${node.fields.map(field => generateNode(field)).join(', ')} }`;

        case 'TableKey':
            return `[${generateNode(node.key)}] = ${generateNode(node.value)}`;

        case 'TableKeyString':
            return `${generateNode(node.key)} = ${generateNode(node.value)}`;

        case 'TableValue':
            return generateNode(node.value);

        case 'BinaryExpression':
        case 'LogicalExpression':
            return `(${generateNode(node.left)} ${node.operator} ${generateNode(node.right)})`;

        case 'UnaryExpression':
            return `(${node.operator} ${generateNode(node.argument)})`;

        case 'MemberExpression':
            return `${generatePrefix(node.base)}${node.indexer}${generateNode(node.identifier)}`;

        case 'IndexExpression':
            return `${generatePrefix(node.base)}[${generateNode(node.index)}]`;

        default:
            throw new Error(`Unhandled AST Node: ${node.type}`);
    }
}

module.exports = { generate: generateNode };
