const test = require('node:test');
const assert = require('node:assert/strict');
const luaparse = require('luaparse');
const { generate } = require('../core/codegen');

function parse(source) {
    return luaparse.parse(source, { luaVersion: '5.1' });
}

test('generate aceita blocos em arrays e os tipos reais de laço do luaparse', () => {
    const source = `
        local function run(items)
            if items then
                while items do break end
            elseif not items then
                repeat items = nil until items
            else
                for i = 1, 3, 2 do items = i end
                for key, value in pairs({1, 2}) do print(key, value) end
                do local scoped = true end
            end
        end
    `;

    const generated = generate(parse(source));
    const reparsed = parse(generated);

    assert.equal(reparsed.body[0].type, 'FunctionDeclaration');
    assert.match(generated, /for i = 1, 3, 2 do/);
    assert.match(generated, /for key, value in pairs/);
});

test('generate preserva a precedência com parênteses em operações', () => {
    const ast = parse('local result = (a + b) * c');
    const generated = generate(ast);

    assert.match(generated, /local result = \(\(a \+ b\) \* c\)/);
    assert.doesNotThrow(() => parse(generated));
});

test('generate emite chamadas, strings e campos de tabela válidos', () => {
    const ast = parse(`local result = {name = "sample", [key] = false, 42}; print "ok"`);
    const generated = generate(ast);

    assert.match(generated, /name = "sample"/);
    assert.match(generated, /\[key\] = false/);
    assert.match(generated, /print "ok"/);
    assert.doesNotThrow(() => parse(generated));
});

test('generate agrupa funções anônimas usadas como base de chamada', () => {
    const ast = parse('local result = (function() return 7 end)()');
    const generated = generate(ast);

    assert.match(generated, /\(function\(\)/);
    assert.doesNotThrow(() => parse(generated));
});

test('generate falha explicitamente para nós que não suporta', () => {
    assert.throws(() => generate({ type: 'UnknownStatement' }), /Unhandled AST Node/);
});
