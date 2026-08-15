# Suíte de testes — extração de atributos por categoria

`suite_extracao_categorias.js` — 81 casos de teste cobrindo as 80 categorias
do CATEGORIA_CANONICA, com frases reais e complexas (múltiplas unidades,
múltiplas tensões, dimensões compostas etc), pensadas pra tentar "quebrar"
o extrator.

## Como rodar

Extraia o bloco de código do app (de `var CATEGORIA_CANONICA` até
`function extrairFatosDeTexto`, mais o bloco `var MARCA_ALIASES` até
`function pareceLocalizacao`), salve num arquivo `.js`, cole o conteúdo
de `suite_extracao_categorias.js` no final, adicione o runner:

```js
let pass = 0, fail = 0;
SUITE_TESTES.forEach((t) => {
  const r = processarTextoParaAtributos(t.texto);
  let ok = r.category_id === t.categoria_esperada;
  Object.entries(t.campos_esperados).forEach(([campo, esperado]) => {
    if (esperado === null) return;
    if (r.atributos[campo] !== esperado) ok = false;
  });
  if (ok) pass++; else fail++;
});
console.log(`${pass}/${SUITE_TESTES.length} PASS, ${fail} FAIL`);
```

E rode com `node arquivo.js`.

## Regra

Depois de qualquer alteração no extrator (CATEGORIA_CANONICA, SCHEMA_FUNCAO,
ou nas funções de extração), rodar essa suíte inteira antes de considerar a
mudança pronta — não só o caso específico que motivou a mudança.
