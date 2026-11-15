#!/usr/bin/env node
// deob.js
// Pipeline principal: deteccao, extracao de LPH_ATTRIBUTES/LPH_PRECHECK e
// lifting consciente de ISA.
//
// Status dos estagios (ver README > Status dos estagios):
//   - deteccao, atributos, prechecks e bypass de precheck: implementados.
//   - lifting (core/devirt.js) e structuring (core/transforms.js): stubs.

const fs = require('fs');
const path = require('path');
const { Command } = require('commander');
const luaparse = require('luaparse');
const { parseAttributes, collectPrechecks } = require('./core/attributes');
const { hookClosures } = require('./core/vmmap');
const { liftWithISA } = require('./core/devirt');
const { structure } = require('./core/structure');
const { generate } = require('./core/codegen');

const STAGE_STATUS = Object.freeze({
    lift: 'stub',      // liftWithISA so anota __lifted
    structure: 'stub', // liftTransformedFunction so anota __transform
});

function detect(source) {
    if (/LPH_ATTRIBUTES|LPH_NO_VIRTUALIZE|LPH_ENCFUNC|LPH_CRASH/.test(source)) {
        return 'luraph_v15';
    }
    if (/return\(\{|local init = \(function/.test(source)) {
        return 'luraph_v14';
    }
    return 'unknown';
}

function log(flags, msg) {
    if (flags.debug) console.log(msg);
}

// NOVO: Função para injetar o bypass do precheck na AST
function applyPrecheckBypass(ast, prechecks, flags) {
    if (prechecks.length === 0) return;

    // Pega o valor esperado do primeiro precheck
    const expected = prechecks[0].expected;
    if (expected === null || expected === undefined) return;

    // Constrói a injeção em string e converte para AST
    const bypassCode = `_G.LPH_PRECHECK = function() return ${JSON.stringify(expected)} end`;
    const bypassAst = luaparse.parse(bypassCode, { luaVersion: '5.1' });
    
    // Insere no topo do script
    ast.body.unshift(bypassAst.body[0]);
    
    log(flags, `[*] Bypass de LPH_PRECHECK injetado no topo da AST (retorno: ${expected})`);
}

function writeGeneratedOutput(input, output, ast, report) {
    const out = output || path.join('output', path.basename(input));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const header = [
        '-- [luraph-v15-deob extended]',
        `-- detected: ${report.kind}`,
        `-- prechecks found: ${report.prechecks}`,
        `-- functions marked lifted: ${report.lifted} (stage "${STAGE_STATUS.lift}" — nao reescreve bytecode ainda)`,
        `-- functions skipped (VM(NONE)): ${report.skipped}`,
        '-- ESTE ARQUIVO NAO FOI DESOFUSCADO DE VERDADE. Ver README > Status dos estagios.',
        '',
    ].join('\n');
    fs.writeFileSync(out, header + generate(ast));
    report.output = out;
}

function processOne(input, output, flags) {
    const report = {
        input, kind: 'unknown', prechecks: 0, lifted: 0, skipped: 0,
        parseOk: false, output: null, error: null,
    };

    let source;
    try {
        source = fs.readFileSync(input, 'utf8');
    } catch (e) {
        report.error = `leitura falhou: ${e.message}`;
        return report;
    }

    report.kind = detect(source);
    log(flags, `[*] ${input}: detected ${report.kind}`);

    if (flags.detect) return report;

    let ast;
    try {
        ast = luaparse.parse(source, { luaVersion: '5.1' });
        report.parseOk = true;
    } catch (e) {
        report.error = `parse da AST falhou: ${e.message}`;
        return report;
    }

    const prechecks = collectPrechecks(ast);
    report.prechecks = prechecks.length;
    log(flags, `[*] ${input}: prechecks found: ${prechecks.length}`);

    // NOVO: Injetando o bypass na AST antes de processar o resto
    applyPrecheckBypass(ast, prechecks, flags);

    const functionAttrs = hookClosures(ast, { register: () => {} });

    if (flags.noDevirt) {
        log(flags, `[*] ${input}: --no-devirt setado; pulando lifting.`);
        writeGeneratedOutput(input, output, ast, report);
        return report;
    }

    functionAttrs.forEach((attrs, fnNode) => {
        fnNode.__attrs = attrs;
        if (attrs.vm === 'NONE') { report.skipped++; return; }
        try {
            liftWithISA(fnNode, null);
            report.lifted++;
        } catch (e) {
            log(flags, `[!] ${input}: lift falhou para ${attrs.vm}: ${e.message}`);
        }
    });

    structure(ast, functionAttrs);
    writeGeneratedOutput(input, output, ast, report);
    return report;
}

function collectInputFiles(input) {
    const stat = fs.statSync(input);
    if (stat.isFile()) return [input];
    if (stat.isDirectory()) {
        return fs.readdirSync(input)
            .filter(f => f.endsWith('.lua') || f.endsWith('.luau'))
            .map(f => path.join(input, f));
    }
    throw new Error(`${input} nao e arquivo nem diretorio`);
}

async function runPool(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    async function take() {
        while (next < items.length) {
            const i = next++;
            results[i] = await worker(items[i]);
        }
    }
    const poolSize = Math.max(1, Math.min(limit || 1, items.length));
    await Promise.all(Array.from({ length: poolSize }, take));
    return results;
}

async function main() {
    const program = new Command();
    program
        .name('luraph-deob')
        .argument('<input>', 'arquivo .lua/.luau ou diretorio')
        .option('-o, --output <file>', 'destino do arquivo desofuscado (so para entrada unica)')
        .option('--detect', 'detecta o ofuscador e sai, sem processar', false)
        .option('--debug', 'imprime logs extras de cada estagio', false)
        .option('--no-devirt', 'so roda deteccao/atributos/prechecks, sem lifting')
        .option('--jobs <n>', 'arquivos processados em paralelo quando a entrada e um diretorio', (v) => parseInt(v, 10), 1)
        .parse(process.argv);

    const input = program.args[0];
    const flags = program.opts();
    flags.noDevirt = flags.devirt === false;

    let files;
    try {
        files = collectInputFiles(input);
    } catch (e) {
        console.error(`[!] ${e.message}`);
        process.exitCode = 1;
        return;
    }

    if (files.length === 0) {
        console.error(`[!] Nenhum .lua/.luau encontrado em ${input}`);
        process.exitCode = 1;
        return;
    }

    const isBatch = files.length > 1;
    if (isBatch && flags.output) {
        console.error('[!] --output nao se aplica a lote (diretorio); use so com um arquivo.');
        process.exitCode = 1;
        return;
    }

    const reports = await runPool(files, flags.jobs, (file) => processOne(file, flags.output, flags));

    let failed = 0;
    for (const r of reports) {
        if (r.error) {
            failed++;
            console.error(`[!] ${r.input}: ${r.error}`);
            continue;
        }
        if (flags.detect) {
            console.log(`[*] ${r.input}: detected ${r.kind}`);
        } else {
            console.log(
                `[+] ${r.input}: output=${r.output} kind=${r.kind} ` +
                `prechecks=${r.prechecks} lifted=${r.lifted} skipped=${r.skipped}`
            );
        }
    }
    if (isBatch) {
        console.log(`[*] Lote: ${reports.length} arquivo(s), ${failed} falha(s).`);
    }

    if (failed > 0) process.exitCode = 1;
}

if (require.main === module) {
    main().catch(e => {
        console.error(`[!] Fatal: ${e.message}`);
        process.exitCode = 1;
    });
}

module.exports = { detect, processOne, collectInputFiles };