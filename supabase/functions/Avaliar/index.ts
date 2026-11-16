// Edge Function: avaliar (v15 — mesmas regras da base que o Lote/Coletor, 02/10)
//
// v15 (02/10/2026) — alinha o Item único com as regras já aplicadas no app:
//   • Base própria: janela de 2 anos (peso 1 até 6 meses, 0,75 até 1 ano,
//     0,5 depois) em vez de 90 dias;
//   • Locação/aluguel nunca entra; preço abaixo de R$ 100 nunca entra;
//   • Leilão só alimenta a faixa de leilão, nunca a de venda;
//   • Novo só compara com novo; usado (seminovo, sucata...) com usado;
//   • Moeda estrangeira convertida para R$ e com peso 0,25 na média (fica
//     fora do mín/máx quando há 3+ anúncios nacionais);
//   • Motor: elétrico não compara com diesel/gasolina (atributo combustível);
//   • Resumo sem "sua própria base"/"sem custo de IA" (cliente não vê isso);
//   • Comparáveis salvos com tipo_mercado e moeda reais, estado Novo/Usado
//     e modelo curto (nunca o título inteiro, nunca tensão).
// NÃO alterado: autenticação, créditos/estorno, validarComparavel, dedup,
// outliers, confiança, funil, proveniência, telemetria.
//
// ---- histórico anterior ----
// v13 — proteção de outlier também na base própria
//
// Corrige um problema real achado ao investigar por que os 15 registros
// contaminados (motor_eletrico com vibrador/redutor/compressor) ainda
// conseguiam distorcer avaliações novas mesmo depois da v12: o caminho de
// base própria (consulta ram calculados sobre TODOS os
// candidatos que passavam no filtro de score — e um candidato com score
// null (sem dado comparável, caso típico dos contaminados: marca null,
// sem atributo técnico em comum) passava o filtro sem penalidade,
// entrando direto no cálculo. O compressor de hidrogênio Nuovo Pignone de
// R$1.700.000 é o exemplo real que expôs isso.
//
// Correção mínima aprovada: extraída removerOutliersPorPreco() da lógica
// que já existia (mesma regra de IQR 1.5x, mesma guarda de 4+ itens) -
// agora reutilizada nos DOIS caminhos (base própria E IA), garantindo que
// os dois rodem literalmente a mesma implementação, não duas cópias que
// poderiam divergir no futuro. Um item com score null NÃO tem tratamento
// especial dentro dessa função - só o preço importa pra decidir outlier,
// então um comparável de score null que também for outlier de preço é
// removido igual a qualquer outro.
//
// Testado: 8/8 (outlier extremo removido, dados normais preservados,
// poucos comparáveis não quebra em nenhum dos 3 sub-casos, score null não
// escapa da proteção mas também não é penalizado indevidamente quando
// está dentro da faixa normal). Confirmado que o caminho de IA produz
// exatamente o mesmo resultado numérico de antes (mesma lógica, só
// reorganizada). Suíte de extração 81/81.
//
// NÃO alterado: validarComparavel(), Compatibility Score, classificação
// de categorias, lógica de extração, marca_aliases, Lote. Nenhum SQL,
// nenhuma migration.
//
// Contém tudo da v12 (validarComparavel com 4 regras), v11 (categoria
// compatível), v10 (reprodutibilidade), v9 (dedup/qualidade/confiança/
// funil), v8 (confiança na foto), v7 (proveniência/cache/score por
// categoria/telemetria/abstração de provider).

import { createClient } from "jsr:@supabase/supabase-js@2";

// Versão do motor/prompt — muda sempre que a lógica de valuation ou o
// prompt principal mudar de forma que afetaria o resultado. Salva junto
// com cada avaliação (telemetria) pra reprodutibilidade.
const VERSAO_MOTOR = "v15";
const VERSAO_PROMPT = "2026-10-02-v15";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function normalizarTexto(t) {
  return (t || "").toString().trim().toLowerCase();
}

// ===== Regras da base (v15, iguais às do app) =====
const PRECO_MINIMO_BRL = 100; // abaixo disso é lance simbólico/peça, não valor de equipamento
const BASE_PROPRIA_VALIDADE_DIAS = 730; // anúncio pode ficar 1-2 anos no mercado
const PESO_PRECO_ESTRANGEIRO = 0.25; // referência útil, mas poder de compra é outro

const RE_ESTADO_NOVO = /\bnov[oa]s?\b|\bsem uso\b|\bnunca usad[oa]\b|\b0\s*km\b|\bzero\s*km\b|\blacrad[oa]\b|\bna caixa\b|\bzerad[oa]\b/i;
const RE_ESTADO_SEMINOVO = /semi[\s-]?nov[oa]|seminov[oa]/i;
// "Novo" só quando o texto diz (novo, sem uso, lacrado...). Resto = "Usado".
// "como novo", "estado de novo", "quase novo" = usado bem conservado
const RE_PARECE_NOVO = /\b(?:como|estado de|quase|tipo|igual a|parece|praticamente|feito)\s+nov[oa]s?\b/gi;
function estadoNovoOuUsado(texto) {
  const t = String(texto || "").replace(RE_PARECE_NOVO, " ");
  return RE_ESTADO_NOVO.test(t) && !RE_ESTADO_SEMINOVO.test(t) ? "Novo" : "Usado";
}
const RE_ALUGUEL = /\b(alug(a|o|amos|uel|ueis)|loca[çc](ã|a)o|locamos|para locar|di[áa]ria|por m[êe]s)\b/i;
function ehLocacao(tipoMercado, texto) {
  return /loca/i.test(String(tipoMercado || "")) || RE_ALUGUEL.test(String(texto || ""));
}
function ehLeilao(tipoMercado, texto) {
  return /leil/i.test(String(tipoMercado || "")) || /\bleil[ãa]o\b|\blance\b|\barremat/i.test(String(texto || ""));
}
function pesoPorIdade(dataObs) {
  if (!dataObs) return 0.5;
  const dias = (Date.now() - new Date(dataObs).getTime()) / 864e5;
  return dias <= 180 ? 1 : dias <= 365 ? 0.75 : 0.5;
}

// Combustível do motor: elétrico não compara com diesel/gasolina.
const COMBUSTIVEIS = [
  ["Biodiesel", /\bbio[\s-]?diesel\b/i],
  ["Diesel", /\bdiesel\b|\bs[\s-]?10\b|\bs[\s-]?500\b/i],
  ["Biogás/Biometano", /\bbiog[áa]s\b|\bbiometano\b/i],
  ["GNV", /\bgnv\b|\bg[áa]s natural\b/i],
  ["Gasolina", /\bgasolina\b/i],
  ["Etanol", /\betanol\b|\b[áa]lcool\b/i],
  ["Hidrogênio", /\bhidrog[êe]nio\b/i],
  ["Eletricidade", /\bel[ée]tric[oa]\b|\btrif[áa]sic[oa]\b|\bmonof[áa]sic[oa]\b/i],
];
function detectarCombustivel(texto) {
  const t = String(texto || "");
  const achados = COMBUSTIVEIS.filter(([, re]) => re.test(t)).map(([nome]) => nome);
  const unicos = achados.filter((n) => !(n === "Diesel" && achados.includes("Biodiesel")));
  return unicos.length === 1 ? unicos[0] : null; // mais de um (ex: flex) = não decide
}

// Cotação (R$ por unidade da moeda). Cache de 30 min na instância.
let _cotacoes = null;
let _cotacoesTempo = 0;
async function buscarCotacoes() {
  if (_cotacoes && Date.now() - _cotacoesTempo < 30 * 60 * 1000) return _cotacoes;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=BRL&to=EUR,USD,GBP", { signal: controller.signal });
    if (!res.ok) return _cotacoes;
    const data = await res.json();
    _cotacoes = { BRL: 1, EUR: 1 / data.rates.EUR, USD: 1 / data.rates.USD, GBP: 1 / data.rates.GBP };
    _cotacoesTempo = Date.now();
    return _cotacoes;
  } catch {
    return _cotacoes; // sem cotação: preço estrangeiro fica de fora (não chuta câmbio)
  } finally {
    clearTimeout(timeoutId);
  }
}
function normalizarMoeda(m) {
  const t = String(m || "BRL").toUpperCase().trim();
  if (/^(R\$|BRL|REAL)/.test(t)) return "BRL";
  if (/^(€|EUR)/.test(t)) return "EUR";
  if (/^(US\$|\$|USD|DOLAR|DÓLAR)/.test(t)) return "USD";
  if (/^(£|GBP)/.test(t)) return "GBP";
  return "BRL";
}
function converterParaBRL(preco, moeda, cotacoes) {
  const p = Number(preco);
  if (!p || isNaN(p)) return null;
  const m = normalizarMoeda(moeda);
  if (m === "BRL") return p;
  return cotacoes && cotacoes[m] ? p * cotacoes[m] : null;
}

// Modelo curto: só o código (ex: "W22", "8FG25", "ML-200"). Nunca título
// inteiro, nunca tensão, nunca adjetivo. Sem dígito = null.
const RE_TENSAO_COMBO = /\b(?:110|127|220|380|440|460|480|660)(?:\s*\/\s*(?:110|127|220|380|440|460|480|660))+\s*v?\b|\b\d{2,3}\s*v\b/gi;
function modeloCurto(modelo) {
  if (!modelo) return null;
  let m = String(modelo).replace(RE_TENSAO_COMBO, " ").replace(/\s{2,}/g, " ").trim();
  if (!m) return null;
  const palavras = m.split(/\s+/);
  if (palavras.length <= 3 && /\d/.test(m)) return m;
  // título longo: fica com o primeiro token que parece código (letra+dígito, ou com - /)
  const codigo = palavras.find((w) => /[a-z]/i.test(w) && /\d/.test(w) && !/^\d+([.,]\d+)?(cv|hp|kw|kva|v|hz|rpm|kg|ton|mm|m3|m³|bar|psi)$/i.test(w));
  if (codigo) return codigo.replace(/[,;.]+$/, "");
  // sigla em maiúsculas seguida de número (ex: "CSL 20", "MSV 40")
  const i = palavras.findIndex((w, k) => /^[A-Z]{2,5}$/.test(w) && /^\d{2,5}$/.test(palavras[k + 1] || ""));
  return i >= 0 ? `${palavras[i]} ${palavras[i + 1]}` : null;
}

// Combustível do item avaliado (categoria Motor): o que o usuário informou,
// senão o que estiver escrito no modelo/observações, senão Eletricidade.
function combustivelDoItem(item) {
  const informado = item.atributosExtras && item.atributosExtras.combustivel;
  if (informado) return String(informado);
  return detectarCombustivel([item.modelo, item.obs].filter(Boolean).join(" ")) || "Eletricidade";
}

function buildPrompt(item, temFotos) {
  const linhas = [
    item.categoria && `Categoria: ${item.categoria}`,
    item.marca && `Marca/fabricante: ${item.marca}`,
    item.modelo && `Modelo: ${item.modelo}`,
    item.potenciaKw && `Potência: ${item.potenciaKw} kW`,
    item.potenciaCv && `Potência: ${item.potenciaCv} CV`,
    item.pesoKg && `Peso: ${item.pesoKg} kg`,
    item.anoFabricacao && `Ano de fabricação: ${item.anoFabricacao}`,
    item.rpm && `Rotação: ${item.rpm} RPM`,
    item.estado && `Estado de conservação: ${item.estado}`,
    item.obs && `Observações: ${item.obs}`,
  ].filter(Boolean).join("\n");
  const semTextoNenhum = linhas.length === 0 && temFotos;
  const instrucaoFoto = temFotos ? `
Uma ou mais fotos do equipamento foram anexadas a esta mensagem (podendo incluir foto da placa de identificação).
${semTextoNenhum ? "\nNenhuma informação em texto foi fornecida — identifique categoria, marca, modelo, potência e ano INTEIRAMENTE a partir das fotos (principalmente a placa de identificação, se houver). Se algo não for identificável com confiança, deixe null em vez de adivinhar.\n" : ""}
Se houver foto legível da placa de identificação, ela é a fonte MAIS CONFIÁVEL para marca/modelo/potência/ano — priorize-a mesmo em caso de conflito com o texto informado. Nunca infira marca a partir de cor/formato/aparência genérica, só quando estiver escrita/visível.
Preencha o campo "item_identificado" da ferramenta com o que foi lido da foto (categoria/marca/modelo/potência/ano), com "confianca" honesta (baixa se a imagem não estava totalmente nítida) e "origem". Se não identificou nada com confiança, pode deixar os campos individuais null, mas ainda assim reporte confianca="baixa" e origem="nao_identificado" em vez de omitir o objeto inteiro.
` : "";
  return `Você é um avaliador de ativos industriais no mercado brasileiro. Pesquise de forma objetiva (no máximo 3-4 buscas — há um limite de tempo de resposta, então priorize velocidade sobre exaustividade). Use os dados abaixo:
${instrucaoFoto}
${linhas}
Regras:
- CRÍTICO: nunca infira marca/fabricante sem evidência explícita no texto, nas fotos ou nos dados informados — nunca a partir de cor/formato/aparência genérica. Na dúvida, não mencione marca.
- CRÍTICO: cada comparável precisa ser genuinamente do MESMO TIPO de equipamento que está sendo pesquisado (categoria "${item.categoria || "não informada"}") — não um equipamento diferente que só apareceu na busca por ter palavra parecida ou peça em comum. Exemplo: um vibrador de concreto tem motor elétrico dentro, mas NÃO é um "motor elétrico" à venda — não é comparável válido pra essa categoria. Marque "categoria_compativel": false pra qualquer comparável que não seja genuinamente o mesmo tipo de equipamento, mesmo que relacionado ou de "compatibilidade" técnica alta.
- Identifique o estado (Novo/Seminovo/Usado/Não informado) de cada comparável e priorize o cálculo pelo estado igual/mais próximo ao do item (estado do item: "${item.estado || "não informado"}").
- Dê "compatibilidade" (alta/média/baixa) por comparável.
- NUNCA use anúncio de aluguel/locação, nem peça/acessório avulso — só o equipamento completo à venda.
- Informe em cada comparável o "tipo_mercado" (Venda Direta ou Leilão) e a "moeda" do preço como anunciado (BRL, USD, EUR ou GBP) — não converta o preço.${item.categoria_id === "motor_eletrico" ? `
- Motor: compare só motores com o MESMO combustível do item (${combustivelDoItem(item)}) — elétrico não é comparável com diesel/gasolina e vice-versa. Informe "combustivel" em atributos_extra.` : ""}
- Estime também uma faixa de LEILÃO (normalmente mais baixa que venda direta).
- Liste no máximo 6 comparáveis.
- Depois de pesquisar, reporte o resultado final chamando a ferramenta "reportar_avaliacao" com os campos preenchidos. Não escreva o resultado como texto — use a ferramenta.`;
}

// Versão condensada, usada SÓ na 2ª tentativa (quando a 1ª truncou por
// max_tokens ou não deu pra interpretar o retorno). Pede bem menos da IA
// - menos buscas, no máximo 3 comparáveis, resumo de 1 frase - reduzindo a
// chance de cortar de novo. As mesmas regras críticas de marca/categoria
// continuam obrigatórias, só o volume pedido é menor.
function buildPromptCondensado(item, temFotos) {
  const linhas = [
    item.categoria && `Categoria: ${item.categoria}`,
    item.marca && `Marca/fabricante: ${item.marca}`,
    item.modelo && `Modelo: ${item.modelo}`,
    item.potenciaKw && `Potência: ${item.potenciaKw} kW`,
    item.potenciaCv && `Potência: ${item.potenciaCv} CV`,
    item.pesoKg && `Peso: ${item.pesoKg} kg`,
    item.anoFabricacao && `Ano de fabricação: ${item.anoFabricacao}`,
    item.rpm && `Rotação: ${item.rpm} RPM`,
    item.estado && `Estado de conservação: ${item.estado}`,
    item.obs && `Observações: ${item.obs}`,
  ].filter(Boolean).join("\n");
  const instrucaoFoto = temFotos ? "\nUma ou mais fotos do equipamento foram anexadas (pode incluir a placa de identificação) - use como fonte confiável. Preencha item_identificado se identificar algo.\n" : "";
  return `Você é um avaliador de ativos industriais no mercado brasileiro. A tentativa anterior de avaliar este item foi cortada por ser complexa demais - seja MUITO mais direto e resumido desta vez. Faça no máximo 2 buscas rápidas. Use os dados abaixo:
${instrucaoFoto}
${linhas}
Regras (resumidas, mas ainda obrigatórias):
- CRÍTICO: nunca infira marca sem evidência explícita.
- CRÍTICO: cada comparável precisa ser genuinamente da mesma categoria pesquisada ("${item.categoria || "não informada"}") - marque categoria_compativel=false se não for.
- Nunca use aluguel/locação nem peça avulsa. Informe tipo_mercado e moeda de cada comparável.
- Resumo em UMA frase curta.
- Liste no MÁXIMO 3 comparáveis (menos que o normal, de propósito, pra caber na resposta).
- Reporte pela ferramenta "reportar_avaliacao", sem escrever texto solto.`;
}

// Schema da tool: a Anthropic valida e garante que o "input" dela sempre
// bate com essa estrutura — sem precisar confiar em JSON.parse().
//
// V15 (Fase 2): o campo "atributos_extra" por comparável é NOVO — antes só
// existiam potencia_cv/ano/peso_kg fixos. Como a lista de atributos que
// importam MUDA por categoria (motor quer tensão/carcaça, tanque quer
// capacidade, bomba quer vazão), a tool inteira virou uma função que
// recebe as chaves relevantes da categoria sendo avaliada e monta a
// descrição na hora — não existem 80 tools hardcoded, é uma só, adaptada.
function construirAvaliacaoTool(atributosExtraRelevantes) {
  const comparavelProperties = {
    titulo: { type: "string" },
    preco: { type: "number" },
    fonte: { type: "string" },
    url: { type: "string" },
    estado: { type: "string" },
    tipo_mercado: { type: "string", enum: ["Venda Direta", "Leilão", "Locação"], description: "Venda Direta para anúncio de venda; Leilão para lote/lance de leilão; Locação para aluguel (aluguel NÃO deve ser usado como comparável)" },
    moeda: { type: "string", enum: ["BRL", "USD", "EUR", "GBP"], description: "Moeda do preço exatamente como anunciado — não converta o valor" },
    compatibilidade: { type: "string", enum: ["alta", "média", "baixa"] },
    marca: { type: ["string", "null"], description: "Marca/fabricante DESSE comparável específico, se identificável no anúncio — null se não identificável, nunca copiar a marca do item pesquisado" },
    modelo: { type: ["string", "null"], description: "Modelo DESSE comparável específico, se identificável — null se não identificável" },
    potencia_cv: { type: ["number", "null"], description: "Potência em CV DESSE comparável, se mencionada no anúncio" },
    potencia_kw: { type: ["number", "null"], description: "Potência em kW DESSE comparável, se mencionada no anúncio (só preencher se o anúncio usar kW, não converter de CV)" },
    ano: { type: ["number", "null"], description: "Ano de fabricação DESSE comparável, se mencionado no anúncio" },
    peso_kg: { type: ["number", "null"], description: "Peso em kg DESSE comparável, se mencionado no anúncio" },
    rpm: { type: ["number", "null"], description: "Rotação em RPM DESSE comparável, se mencionada no anúncio" },
    categoria_observada: { type: "string", description: "Que TIPO de equipamento esse comparável específico realmente é, em texto curto (ex: 'Motor elétrico', 'Vibrador de concreto', 'Redutor de velocidade', 'Compressor de ar'). Julgue pelo anúncio em si, não pela categoria que está sendo pesquisada." },
    categoria_compativel: { type: "boolean", description: "true SOMENTE se esse comparável for genuinamente o MESMO TIPO de equipamento que o item pesquisado (a categoria pesquisada está no início desta conversa), não só algo relacionado ou que tenha peça parecida. Ex: um vibrador de concreto NÃO é compatível com 'motor elétrico' mesmo tendo um motor dentro dele. Um redutor NÃO é compatível com 'motor elétrico'. Seja rigoroso — na dúvida, false." },
  };
  if (Array.isArray(atributosExtraRelevantes) && atributosExtraRelevantes.length > 0) {
    comparavelProperties.atributos_extra = {
      type: ["object", "null"],
      description: `Atributos técnicos ADICIONAIS desse comparável específico, quando mencionados no anúncio, usando exatamente estas chaves (pule a chave inteira se o anúncio não mencionar): ${atributosExtraRelevantes.join(", ")}. Valores podem ser número ou texto curto, conforme o atributo (ex: {"tensao_v": "380/660", "carcaca": "200L"}). Não invente valor — só preencha o que estiver escrito no anúncio.`,
    };
  }
  return {
    name: "reportar_avaliacao",
    description: "Reporta o resultado final da avaliação de mercado do ativo pesquisado, com a faixa de valores e os comparáveis encontrados.",
    input_schema: {
      type: "object",
      properties: {
        resumo: { type: "string", description: "Resumo curto de como a estimativa foi calculada" },
        faixa_min: { type: "number" },
        faixa_media: { type: "number" },
        faixa_max: { type: "number" },
        leilao_min: { type: "number" },
        leilao_max: { type: "number" },
        reais_por_kg: { type: ["number", "null"] },
        reais_por_cv: { type: ["number", "null"] },
        item_identificado: {
          type: ["object", "null"],
          description: "SÓ preencher quando havia foto e algum dado do próprio equipamento (não do comparável) foi identificado a partir da imagem (placa de identificação, etiqueta etc). Deixe o objeto inteiro null se não havia foto, ou se o usuário já tinha digitado tudo em texto (não precisa re-reportar o que já veio digitado).",
          properties: {
            categoria: { type: ["string", "null"] },
            marca: { type: ["string", "null"] },
            modelo: { type: ["string", "null"] },
            potencia_cv: { type: ["number", "null"] },
            ano: { type: ["number", "null"] },
            confianca: { type: "string", enum: ["alta", "média", "baixa"], description: "Confiança geral da leitura da foto/placa — baixa se a imagem estava desfocada, parcialmente ilegível, ou se teve que inferir algo" },
            origem: { type: "string", enum: ["placa_legivel", "foto_geral", "nao_identificado"], description: "placa_legivel = leu direto de uma placa/etiqueta nítida; foto_geral = inferiu do aspecto do equipamento (menos confiável); nao_identificado = não deu pra identificar nada" },
          },
        },
        comparaveis: {
          type: "array",
          maxItems: 6,
          items: {
            type: "object",
            properties: comparavelProperties,
            required: ["titulo", "preco", "fonte", "url", "estado", "compatibilidade", "categoria_observada", "categoria_compativel"],
          },
        },
      },
      required: ["resumo", "faixa_min", "faixa_media", "faixa_max", "leilao_min", "leilao_max", "comparaveis"],
    },
  };
}

// Fallback: acha o primeiro objeto JSON BALANCEADO no texto (conta chaves
// de verdade, não "primeira { até última }" como antes — isso evita pegar
// lixo do meio quando há texto extra antes/depois do JSON real).
function extrairJsonBalanceado(texto) {
  const inicio = texto.indexOf("{");
  if (inicio === -1) return null;
  let profundidade = 0;
  for (let i = inicio; i < texto.length; i++) {
    if (texto[i] === "{") profundidade++;
    else if (texto[i] === "}") {
      profundidade--;
      if (profundidade === 0) return texto.slice(inicio, i + 1);
    }
  }
  return null; // nunca fechou = provavelmente truncado
}

// Camada de abstração de AI provider — hoje só a Anthropic está implementada,
// mas o resto do código chama essa função, não a API da Anthropic direto.
// Trocar ou adicionar provider no futuro (Perplexity/OpenAI) significa
// implementar essa mesma assinatura, sem mexer no resto da lógica.
// IMPORTANTE: essa troca só deve acontecer depois de ter telemetria real
// suficiente pra comparar custo/qualidade/erro entre providers - não antes.
async function chamarAIProvider({ conteudoMensagem, tools, maxTokens }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000); // 90s - nunca fica pendurado pra sempre
  try {
    return await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: maxTokens ?? 5000,
        messages: [{ role: "user", content: conteudoMensagem }],
        tools,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

Deno.serve(async (req) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  const tInicioTotal = Date.now();

  console.log(`AVALIAR_LOG [${reqId}] INICIO ts=${new Date().toISOString()} method=${req.method}`);

  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  // 1) AUTENTICAÇÃO REAL — valida o JWT do usuário logado (não mais a
  // chave pública/APP_ACCESS_KEY, que qualquer um consegue ver no navegador).
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    console.log(`AVALIAR_LOG [${reqId}] AUTH_FALHOU motivo=sem_jwt`);
    return new Response(JSON.stringify({ error: "Sessão ausente. Faça login novamente." }), {
      status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Cliente "como o usuário" — usa a ANON KEY (pública, uso correto aqui) +
  // o JWT da sessão. auth.uid() dentro das funções do banco (consumir_credito
  // etc) resolve certinho pro usuário logado através desse cliente.
  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_ANON_KEY"),
    { global: { headers: { Authorization: `Bearer ${jwt}` } } }
  );
  const { data: userData, error: userErr } = await supabaseUser.auth.getUser(jwt);
  if (userErr || !userData || !userData.user) {
    console.log(`AVALIAR_LOG [${reqId}] AUTH_FALHOU motivo=jwt_invalido`);
    return new Response(JSON.stringify({ error: "Sessão inválida ou expirada. Faça login novamente." }), {
      status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  console.log(`AVALIAR_LOG [${reqId}] AUTH_OK user=${userData.user.id.slice(0, 8)}`);

  let creditoConsumido = false; // fora do try pra ficar visível no catch geral também
  async function estornarSeNecessario(motivo) {
    if (!creditoConsumido) return;
    creditoConsumido = false;
    try {
      await supabaseUser.rpc("estornar_credito", { qtd: 1, motivo });
      console.log(`AVALIAR_LOG [${reqId}] ESTORNO_OK motivo="${motivo}"`);
    } catch (e) {
      console.log(`AVALIAR_LOG [${reqId}] ESTORNO_FALHOU erro="${e && e.message || String(e)}"`);
    }
  }

  try {
    const item = await req.json();
    const fotos = Array.isArray(item.photos) ? item.photos.slice(0, 3) : [];
    const temFotos = fotos.length > 0;
    console.log(`AVALIAR_LOG [${reqId}] ITEM categoria="${item.categoria || ""}" marca="${item.marca || ""}" fotos=${fotos.length}`);

    // service role só pra leitura/escrita ampla na base de mercado — nunca
    // usado pra nada que dependa de identidade (isso é sempre via supabaseUser)
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL"),
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    );

    // Mapa entre nome do atributo no SCHEMA_FUNCAO (snake_case, específico
    // por categoria) e o campo correspondente no formulário simples que a
    // Edge Function recebe hoje. Atributos que não têm campo equivalente no
    // formulário simples (ex: tensao_v, carcaca, capacidade_ton) são pulados
    // silenciosamente — o score usa só o que dá pra comparar de verdade.
    const MAPA_ATRIBUTO_PARA_CAMPO_ITEM = {
      potencia_cv: "potenciaCv",
      potencia_kw: "potenciaKw",
      ano: "anoFabricacao",
      peso_kg: "pesoKg",
      rpm: "rpm",
    };

    // Score de compatibilidade (0-100), configurável por categoria via
    // ranking_importancia (mandado pelo frontend, gerado a partir do
    // SCHEMA_FUNCAO de cada categoria) — em vez de pesos fixos iguais pra
    // motor/tanque/compressor/bomba, cada categoria pesa os atributos que
    // ela mesma já define como prioritários (valuation.obrigatorios primeiro).
    // Pesos por posição no ranking (decrescente) são uma heurística de
    // partida, não validada com dados reais ainda.
    const PESOS_POR_POSICAO = [30, 22, 16, 12, 8, 6, 4];
    function calcularScoreCompatibilidade(item, candidato, rankingImportancia) {
      let score = 0;
      let maxPossivel = 0;

      if (item.marca && candidato.marca) {
        maxPossivel += 15;
        if (normalizarTexto(item.marca) === normalizarTexto(candidato.marca)) score += 15;
      }
      if (item.estado && candidato.estado) {
        maxPossivel += 15;
        // v15: compara a classe Novo/Usado ("Usado - funcionando" = "Usado")
        if (estadoNovoOuUsado(item.estado) === estadoNovoOuUsado(candidato.estado)) score += 15;
      }

      if (Array.isArray(rankingImportancia)) {
        rankingImportancia.forEach((atributo, idx) => {
          const campoItem = MAPA_ATRIBUTO_PARA_CAMPO_ITEM[atributo];
          // V15 (Fase 2): quando o atributo não tem campo fixo (tensão,
          // carcaça, vazão etc.), tenta achar em item.atributosExtras —
          // preenchido pelo formulário dinâmico do frontend. Se nenhum dos
          // dois existir, pula igual antes (não soma nem penaliza).
          const valorItemBruto = campoItem ? item[campoItem] : (item.atributosExtras && item.atributosExtras[atributo]);
          const valorItem = Number(valorItemBruto);
          const valorCandidato = candidato.atributos_normalizados && Number(candidato.atributos_normalizados[atributo]);
          if (!valorItem || !valorCandidato || isNaN(valorItem) || isNaN(valorCandidato)) return; // sem dado dos dois lados, ou valor não-numérico (ex: "380/660"): não soma nem penaliza
          const peso = PESOS_POR_POSICAO[idx] || 3;
          maxPossivel += peso;
          const razao = valorCandidato / valorItem;
          if (razao >= 0.6 && razao <= 1.6) score += peso; // bem próximo: peso cheio
          else if (razao >= 0.4 && razao <= 2.5) score += peso * 0.5; // razoável: meio peso
          // fora disso: zero pra esse atributo, mas não exclui o candidato
        });
      }

      if (maxPossivel === 0) return null; // não deu pra comparar nada de verdade
      return Math.round((score / maxPossivel) * 100);
    }

    // Carrega os aliases de marca do banco (mesma tabela da Fase 1 de
    // normalização, criada pra ser lida tanto pelo frontend quanto por
    // aqui) - resiliente: se a tabela ainda não existir ou a consulta
    // falhar, devolve mapa vazio e a marca simplesmente não é normalizada
    // (não quebra nada, só não aplica a normalização).
    async function carregarMarcaAliasesServidor() {
      try {
        const { data, error } = await supabase.from("marca_aliases").select("alias, marca_canonica");
        if (error || !data) return {};
        const mapa = {};
        data.forEach((row) => {
          if (row.alias && row.marca_canonica) mapa[row.alias] = row.marca_canonica;
        });
        return mapa;
      } catch (e) {
        console.log(`AVALIAR_LOG [${reqId}] MARCA_ALIASES_FALHOU erro="${e && e.message || String(e)}"`);
        return {};
      }
    }

    // ===== validarComparavel() =====
    // Camada de validação determinística, obrigatória, que roda ANTES de
    // qualquer comparável ser persistido. Diferente do filtro de categoria
    // (que confia no que a própria IA reportou via categoria_compativel),
    // essa função aplica regras fixas e auditáveis:
    //
    // IMPORTANTE - limite honesto desta implementação: o pedido original
    // menciona "validar a categoria usando SCHEMA_FUNCAO" - o classificador
    // completo de 80 categorias (CATEGORIA_CANONICA/SCHEMA_FUNCAO) vive só
    // no frontend, portar ele inteiro pra cá seria mudança de arquitetura
    // (proibida nesta etapa). Em vez disso, a validação de categoria aqui
    // combina o sinal já reportado pela IA (categoria_compativel, v11) com
    // uma checagem extra determinística de sobreposição textual entre a
    // categoria observada do comparável e a categoria pesquisada - não
    // depende só da IA "achar" que está certo, mas também não reclassifica
    // do zero com o motor completo.
    function validarComparavel(item, c, marcaAliasesMap, reqId) {
      const motivos = [];

      // Regra 1: categoria - sinal da IA (v11) + checagem determinística de
      // sobreposição textual como segunda camada independente.
      if (c.categoria_compativel === false) {
        motivos.push("categoria_incompativel_reportada_pela_ia");
      }
      if (c.categoria_observada && item.categoria) {
        const palavrasRelevantesItem = normalizarTexto(item.categoria).split(/\s+/).filter((w) => w.length > 3);
        const textoObservadoNormalizado = normalizarTexto(c.categoria_observada);
        const temSobreposicao = palavrasRelevantesItem.some((w) => textoObservadoNormalizado.includes(w));
        if (!temSobreposicao && palavrasRelevantesItem.length > 0) {
          motivos.push("categoria_sem_sobreposicao_textual");
        }
      }

      // Regra 2: marca - normaliza via marca_aliases (não invalida por si
      // só, só ajusta o valor que será salvo).
      let marcaNormalizada = c.marca || null;
      if (marcaNormalizada && marcaAliasesMap) {
        const chave = marcaNormalizada.trim().toUpperCase();
        if (marcaAliasesMap[chave]) marcaNormalizada = marcaAliasesMap[chave];
      }

      // Regra 3: modelo deve existir como texto.
      if (!c.modelo || !String(c.modelo).trim()) {
        motivos.push("modelo_ausente");
      }

      // Regra 4: score mínimo de compatibilidade = 50. Quando não dá pra
      // calcular (sem dado nenhum pra comparar - nem marca, nem estado,
      // nem atributo numérico), trata como reprovado também - não existe
      // meio-termo pedido aqui, a regra é score >= 50, e null não atinge isso.
      const scoreComparavel = calcularScoreCompatibilidade(
        item,
        // V15 (Fase 2): antes só passava potencia_cv/ano/peso_kg pro score
        // (bug real - nem potencia_kw/rpm, que já eram campos fixos,
        // entravam aqui). Agora inclui os 5 campos fixos + atributos_extra
        // (novo, dinâmico por categoria) que a IA reportou pra esse
        // comparável específico.
        { marca: marcaNormalizada, estado: c.estado, atributos_normalizados: { potencia_cv: c.potencia_cv, potencia_kw: c.potencia_kw, ano: c.ano, peso_kg: c.peso_kg, rpm: c.rpm, ...(c.atributos_extra || {}) } },
        item.ranking_importancia
      );
      if (scoreComparavel === null || scoreComparavel < 50) {
        motivos.push(`score_abaixo_do_minimo(${scoreComparavel === null ? "sem_dado" : scoreComparavel})`);
      }

      const valido = motivos.length === 0;
      console.log(`AVALIAR_LOG [${reqId}] VALIDAR_COMPARAVEL titulo="${c.titulo || ""}" categoria_detectada="${c.categoria_observada || "não informada"}" categoria_esperada="${item.categoria || ""}" score=${scoreComparavel === null ? "null" : scoreComparavel} valido=${valido}${motivos.length > 0 ? ` motivos="${motivos.join(",")}"` : ""}`);

      return { valido, motivos, marcaNormalizada, score: scoreComparavel };
    }

    // ===== removerOutliersPorPreco() =====
    // Extraída da lógica de detecção de outliers que já existia SÓ no
    // caminho de IA (regra clássica de IQR, 1.5x o intervalo interquartil,
    // só aplicada com 4+ itens - dado de menos pra decidir outlier com
    // segurança abaixo disso). Agora reutilizada também no caminho de base
    // própria, que nunca tinha essa proteção - min/max eram calculados
    // sobre TODOS os candidatos, mesmo um preço absurdamente fora da
    // distribuição. Funciona sobre qualquer array de itens com `.preco`,
    // sem depender de score/categoria/marca - um item com score null não
    // tem tratamento especial aqui, passa pelo mesmo filtro que qualquer
    // outro (satisfaz a regra de que score null não pode ser usado como
    // desculpa pra escapar da proteção estatística).
    function removerOutliersPorPreco(itens, reqId, contexto) {
      if (!itens || itens.length < 4) return { itens: itens || [], removidos: 0 };
      const precosOrdenados = itens.map((it) => Number(it.preco)).sort((a, b) => a - b);
      const q1 = precosOrdenados[Math.floor(precosOrdenados.length * 0.25)];
      const q3 = precosOrdenados[Math.floor(precosOrdenados.length * 0.75)];
      const iqr = q3 - q1;
      const limiteInferior = q1 - 1.5 * iqr;
      const limiteSuperior = q3 + 1.5 * iqr;
      const antesOutlier = itens.length;
      const itensFiltrados = itens.filter((it) => {
        const preco = Number(it.preco);
        return preco >= limiteInferior && preco <= limiteSuperior;
      });
      const removidos = antesOutlier - itensFiltrados.length;
      if (removidos > 0) {
        console.log(`AVALIAR_LOG [${reqId}] OUTLIER_REMOVIDO contexto="${contexto}" antes=${antesOutlier} depois=${itensFiltrados.length} limite_inferior=${limiteInferior.toFixed(2)} limite_superior=${limiteSuperior.toFixed(2)}`);
      }
      return { itens: itensFiltrados, removidos };
    }


    // ===== Capacidade comparável (16/11) =====
    // Item com capacidade informada só compara com itens de capacidade
    // parecida (metade a dobro), na mesma unidade: TR (chiller - kcal/h vira
    // TR), L/h, kg/h, un/h ou volume em L (tanque).
    function numBR(v) {
      if (typeof v === "number") return v;
      const m = String(v || "").match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/);
      if (!m) return NaN;
      let t = m[0];
      if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
      else t = t.replace(",", ".");
      return Number(t);
    }
    function trDe(v) {
      if (v === null || v === undefined || v === "") return null;
      const s = String(v);
      let n = numBR(v);
      if (!isFinite(n) || n <= 0) return null;
      if (/kcal/i.test(s) || n > 2000) n = n / 3024; // kcal/h -> TR
      return Math.round(n * 10) / 10;
    }
    function capacidadeComparavel(attrs, texto, aceitaVolume) {
      attrs = attrs || {};
      const tr = trDe(attrs.capacidade_tr);
      if (tr) return { valor: tr, unidade: "TR" };
      if (Number(attrs.capacidade_bph) > 0) return { valor: Number(attrs.capacidade_bph), unidade: "un/h" };
      if (Number(attrs.capacidade_lh) > 0) return { valor: Number(attrs.capacidade_lh), unidade: "L/h" };
      if (Number(attrs.capacidade_kgh) > 0) return { valor: Number(attrs.capacidade_kgh), unidade: "kg/h" };
      const vol = aceitaVolume ? numBR(attrs.volume_l) : NaN;
      if (isFinite(vol) && vol > 0) return { valor: vol, unidade: "L" };
      const t = String(texto || "");
      let m = t.match(/(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*kcal/i);
      if (m) { const v = trDe(m[1] + " kcal"); if (v) return { valor: v, unidade: "TR" }; }
      m = t.match(/(?<![\/\d])(\d+(?:[.,]\d+)?)\s+TR\b/);
      if (m) { const v = numBR(m[1]); if (v > 0) return { valor: v, unidade: "TR" }; }
      m = aceitaVolume ? t.match(/(\d{1,3}(?:\.\d{3})+|\d+(?:[.,]\d+)?)\s*(?:l|lt|litros?)\b(?!\s*(?:\/|por\b|p\/))/i) : null;
      if (m) { const v = numBR(m[1]); if (v > 0) return { valor: v, unidade: "L" }; }
      return null;
    }

    // ===== Tamanho comparável por categoria (16/11) =====
    // Com o tamanho do item informado, só entram comparáveis de tamanho
    // parecido (metade a dobro), na mesma unidade. Registro sem tamanho
    // legível fica de fora (mesma regra da capacidade por hora).
    function numBR2(s) {
      let t = String(s);
      if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
      else t = t.replace(",", ".");
      return Number(t);
    }
    const NUM_RE = "(\\d{1,3}(?:\\.\\d{3})+(?:,\\d+)?|\\d+(?:[.,]\\d+)?)";
    function achar(texto, sufixo) {
      const m = String(texto || "").match(new RegExp(NUM_RE + "\\s*" + sufixo, "i"));
      if (!m) return null;
      const v = numBR2(m[1]);
      return isFinite(v) && v > 0 ? v : null;
    }
    function potenciaCvDe(cv, kw, texto) {
      if (Number(cv) > 0) return Number(cv);
      if (Number(kw) > 0) return Math.round(Number(kw) * 1.36 * 100) / 100;
      const c = achar(texto, "(?:cv|hp)\\b");
      if (c) return c;
      const k = achar(texto, "kw\\b");
      return k ? Math.round(k * 1.36 * 100) / 100 : null;
    }
    const CATS_POTENCIA = /^(motor_eletrico|motorredutor|redutor|motovibrador|compressor)$/;
    function tamanhoDe(catId, o) {
      // o: { cv, kw, capacidade, texto, attrs }
      const attrs = o.attrs || {};
      const textoCap = String(o.capacidade || "");
      const textoTudo = [o.capacidade, o.texto].filter(Boolean).join(" ");
      if (CATS_POTENCIA.test(catId || "")) {
        const v = potenciaCvDe(o.cv || numBR2(attrs.potencia_cv || ""), o.kw || numBR2(attrs.potencia_kw || ""), textoTudo);
        return v ? { valor: v, unidade: "CV" } : null;
      }
      if (catId === "caldeira") {
        let v = Number(attrs.capacidade_producao_vapor_kgh) > 0 ? Number(attrs.capacidade_producao_vapor_kgh) : achar(textoTudo, "kg\\s*(?:v|vapor)?\\s*\\/\\s*h");
        if (!v) { const t = achar(textoTudo, "(?:t|ton|tons|toneladas?)\\s*(?:v|vapor)?\\s*\\/\\s*h"); if (t) v = t * 1000; }
        return v ? { valor: v, unidade: "kg/h" } : null;
      }
      if (catId === "empilhadeira") {
        if (Number(attrs.capacidade_carga_kg) > 0) return { valor: Number(attrs.capacidade_carga_kg), unidade: "kg" };
        let v = achar(textoTudo, "kg\\b(?!\\s*\\/)");
        if (!v) { const t = achar(textoTudo, "(?:t|ton|tons|toneladas?)\\b(?!\\s*\\/)"); if (t && t <= 60) v = t * 1000; }
        return v ? { valor: v, unidade: "kg" } : null;
      }
      if (catId === "prensa") {
        const v = Number(attrs.capacidade_toneladas) > 0 ? Number(attrs.capacidade_toneladas) : achar(textoTudo, "(?:t|ton|tons|toneladas?)\\b(?!\\s*\\/)");
        return v ? { valor: v, unidade: "ton" } : null;
      }
      if (catId === "transformador" || catId === "gerador") {
        let v = Number(attrs.potencia_kva) > 0 ? Number(attrs.potencia_kva) : achar(textoTudo, "kva\\b");
        if (!v && catId === "gerador") { const k = achar(textoTudo, "kw\\b"); if (k) v = Math.round(k / 0.8); }
        return v ? { valor: v, unidade: "kVA" } : null;
      }
      if (catId === "bomba") {
        let v = Number(attrs.vazao_m3h) > 0 ? Number(attrs.vazao_m3h) : achar(textoTudo, "m[³3]\\s*(?:\\/\\s*h)?");
        if (v) return { valor: v, unidade: "m³/h" };
        const cv = potenciaCvDe(o.cv || numBR2(attrs.potencia_motor_cv || ""), o.kw, textoTudo);
        return cv ? { valor: cv, unidade: "CV" } : null;
      }
      return undefined; // categoria sem regra de tamanho aqui
    }

    // ===== Base própria (v15) =====
    // Mesmas regras do Lote: 2 anos com peso por idade, sem locação, sem
    // preço < R$100, leilão só na faixa de leilão, novo só com novo,
    // moeda estrangeira convertida e com peso pequeno, motor por combustível.
    let resultadoBasePropria = null;
    if (!temFotos) {
      const tInicioConsultaLocal = Date.now();
      const dataLimite = new Date(Date.now() - BASE_PROPRIA_VALIDADE_DIAS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let query = supabase
        .from("observacoes_mercado")
        .select("preco, moeda, estado, marca, modelo, ano, capacidade, potencia_cv, potencia_kw, localizacao, tipo_mercado, atributos_normalizados, data_observacao")
        .not("preco", "is", null)
        .gte("data_observacao", dataLimite);
      if (item.categoria_id) {
        query = query.eq("categoria_id", item.categoria_id);
      } else {
        // fallback pro texto antigo só se o frontend não conseguiu resolver o id
        query = query.ilike("categoria", `%${normalizarTexto(item.categoria)}%`);
      }
      const [resultado, cotacoes] = await Promise.all([query.limit(200), buscarCotacoes()]);
      const candidatosBrutos = resultado.data || [];

      const itemNovo = estadoNovoOuUsado(item.estado) === "Novo";
      const combItem = item.categoria_id === "motor_eletrico" ? combustivelDoItem(item) : null;
      const descartes = { locacao: 0, preco_baixo: 0, sem_cotacao: 0, estado: 0, combustivel: 0, score: 0, capacidade: 0 };
      const aceitaVolume = /^(tanque|tanque_misturador|resfriador_leite)$/.test(item.categoria_id || "");
      // Tamanho por categoria (potência, kVA, toneladas, carga, vapor, vazão); nas demais, capacidade.
      const tamItem = tamanhoDe(item.categoria_id, { cv: item.potenciaCv, kw: item.potenciaKw, capacidade: item.capacidade, texto: [item.modelo, item.obs].filter(Boolean).join(" "), attrs: item.atributosExtras });
      const usaTamanho = tamItem !== undefined;
      const capItem = usaTamanho ? tamItem : capacidadeComparavel(item.atributosExtras, [item.capacidade, item.modelo, item.obs].filter(Boolean).join(" "), aceitaVolume);
      // capacidade em TR vira número para o score (o campo pode vir "22.000 kcal/h")
      if (capItem && capItem.unidade === "TR" && item.atributosExtras) item.atributosExtras = { ...item.atributosExtras, capacidade_tr: capItem.valor };

      const candidatos = [];
      for (const r of candidatosBrutos) {
        if (ehLocacao(r.tipo_mercado, "")) { descartes.locacao++; continue; }
        const valor = converterParaBRL(r.preco, r.moeda, cotacoes);
        if (valor === null) { descartes.sem_cotacao++; continue; }
        if (valor < PRECO_MINIMO_BRL) { descartes.preco_baixo++; continue; }
        if ((estadoNovoOuUsado(r.estado) === "Novo") !== itemNovo) { descartes.estado++; continue; }
        if (combItem) {
          const combObs = (r.atributos_normalizados && r.atributos_normalizados.combustivel) || "Eletricidade";
          if (combObs !== combItem) { descartes.combustivel++; continue; }
        }
        if (capItem) {
          const capRow = usaTamanho
            ? tamanhoDe(item.categoria_id, { cv: r.potencia_cv, kw: r.potencia_kw, capacidade: r.capacidade, texto: r.modelo, attrs: r.atributos_normalizados })
            : capacidadeComparavel(r.atributos_normalizados, r.capacidade, aceitaVolume);
          if (!capRow || capRow.unidade !== capItem.unidade || capRow.valor < capItem.valor * 0.5 || capRow.valor > capItem.valor * 2) { descartes.capacidade++; continue; }
        }
        const score = calcularScoreCompatibilidade(item, r, item.ranking_importancia);
        // mantém score >= 40 OU sem dado comparável (null) — igual antes
        if (score !== null && score < 40) { descartes.score++; continue; }
        const estrangeiro = normalizarMoeda(r.moeda) !== "BRL";
        candidatos.push({
          preco: valor, // já em R$ — removerOutliersPorPreco olha .preco
          score,
          leilao: ehLeilao(r.tipo_mercado, ""),
          estrangeiro,
          peso: ((score === null ? 50 : score) + 1) * pesoPorIdade(r.data_observacao) * (estrangeiro ? PESO_PRECO_ESTRANGEIRO : 1),
          row: r,
        });
      }
      const vendaBruta = candidatos.filter((c) => !c.leilao);
      const leiloes = candidatos.filter((c) => c.leilao);
      console.log(`AVALIAR_LOG [${reqId}] CONSULTA_LOCAL duracao_ms=${Date.now() - tInicioConsultaLocal} qtd_bruta=${candidatosBrutos.length} venda=${vendaBruta.length} leilao=${leiloes.length} descartes=${JSON.stringify(descartes)} item_novo=${itemNovo} combustivel=${combItem || "-"} desde=${dataLimite}`);

      if (vendaBruta.length >= 3) {
        const { itens: venda, removidos: outliersBase } = removerOutliersPorPreco(vendaBruta, reqId, "base_propria");
        const nacionais = venda.filter((c) => !c.estrangeiro);
        const baseFaixa = nacionais.length >= 3 ? nacionais : venda; // estrangeiro fora do mín/máx quando há 3+ nacionais
        const precosFaixa = baseFaixa.map((c) => c.preco);
        const min = Math.min(...precosFaixa);
        const max = Math.max(...precosFaixa);
        const somaPesos = venda.reduce((a, c) => a + c.peso, 0);
        const media = venda.reduce((a, c) => a + c.preco * c.peso, 0) / (somaPesos || 1);
        const temLeilao = leiloes.length >= 2;
        const leilaoMedia = temLeilao ? leiloes.reduce((a, c) => a + c.preco * c.peso, 0) / (leiloes.reduce((a, c) => a + c.peso, 0) || 1) : null;
        resultadoBasePropria = {
          origem: "base_propria",
          resumo: `Estimativa baseada em ${venda.length} observações de mercado para essa categoria.`,
          faixa_min: Math.round(min),
          faixa_media: Math.round(Math.min(Math.max(media, min), max)),
          faixa_max: Math.round(max),
          leilao_min: temLeilao ? Math.round(Math.min(...leiloes.map((c) => c.preco))) : Math.round(min * 0.6),
          leilao_max: temLeilao ? Math.round(Math.max(leilaoMedia, ...leiloes.map((c) => c.preco))) : Math.round(media * 0.65),
          reais_por_kg: null,
          reais_por_cv: null,
          comparaveis: [],
          qtd_comparaveis_usados: venda.length, // mesma quantidade da média - a tela usa isso
        };
        // 16/11: devolve os comparáveis usados (antes a tela ficava sem eles).
        const nivelCompat = (sc) => (sc === null ? "média" : sc >= 75 ? "alta" : sc >= 50 ? "média" : "baixa");
        resultadoBasePropria.comparaveis = venda
          .slice()
          .sort((a, b) => (b.score ?? 50) - (a.score ?? 50))
          .map((c) => ({
            marca: c.row.marca || null,
            modelo: c.row.modelo || null,
            ano: c.row.ano || null,
            capacidade: c.row.capacidade || null,
            localizacao: c.row.localizacao || null,
            estado: c.row.estado || null,
            preco: Math.round(c.preco),
            moeda: "BRL",
            compatibilidade: nivelCompat(c.score),
            data_observacao: c.row.data_observacao || null,
          }));
        resultadoBasePropria.funil_comparaveis = {
          encontrados: candidatosBrutos.length,
          apos_filtro_qualidade: vendaBruta.length,
          outliers_removidos: outliersBase || 0,
          usados_no_calculo: venda.length,
          leiloes: leiloes.length,
        };
        {
          const precos = venda.map((c) => c.preco).filter((n) => n > 0);
          const disp = precos.length ? Math.max(...precos) / Math.min(...precos) : 999;
          const qtdAlta = resultadoBasePropria.comparaveis.filter((c) => c.compatibilidade === "alta").length;
          resultadoBasePropria.confianca_avaliacao = venda.length >= 4 && qtdAlta >= 2 && disp < 2 ? "alta" : venda.length >= 3 && (qtdAlta > 0 || disp < 3) ? "média" : "baixa";
        }
      }
    } else {
      console.log(`AVALIAR_LOG [${reqId}] CONSULTA_LOCAL pulada (item tem foto)`);
    }

    if (resultadoBasePropria) {
      console.log(`AVALIAR_LOG [${reqId}] CAMINHO=base_propria`);
      console.log(`AVALIAR_LOG [${reqId}] FIM caminho=base_propria duracao_total_ms=${Date.now() - tInicioTotal}`);
      try {
        await supabase.from("avaliacoes_telemetria").insert({
          evaluation_id: crypto.randomUUID(),
          usuario_id: userData.user.id,
          categoria_id: item.categoria_id || null,
          origem: "base_propria",
          cache_hit: true,
          qtd_comparaveis_encontrados: resultadoBasePropria.qtd_comparaveis_usados,
          qtd_comparaveis_apos_filtro: resultadoBasePropria.qtd_comparaveis_usados,
          tempo_total_ms: Date.now() - tInicioTotal,
          sucesso: true,
          resultado_snapshot: resultadoBasePropria,
          versao_motor: VERSAO_MOTOR,
          versao_prompt: VERSAO_PROMPT,
        });
      } catch (telemetriaErr) {
        console.log(`AVALIAR_LOG [${reqId}] TELEMETRIA_FALHOU erro="${telemetriaErr && telemetriaErr.message || String(telemetriaErr)}"`);
      }
      return new Response(JSON.stringify(resultadoBasePropria), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
    }

    console.log(`AVALIAR_LOG [${reqId}] CAMINHO=anthropic_web_search`);

    // 2) CONSOME CRÉDITO AQUI, ANTES de gastar um centavo com a Anthropic.
    //    Se não tiver crédito, para aqui e nem chama a IA.
    const { data: liberado, error: creditoErr } = await supabaseUser.rpc("consumir_credito", { qtd: 1 });
    if (creditoErr) {
      console.log(`AVALIAR_LOG [${reqId}] CREDITO_ERRO erro="${creditoErr.message}"`);
      return new Response(JSON.stringify({ error: "Não foi possível verificar seu saldo de créditos. Tente novamente." }), {
        status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (liberado === false) {
      console.log(`AVALIAR_LOG [${reqId}] SEM_CREDITO`);
      return new Response(JSON.stringify({ error: "Seus créditos acabaram. Entre em contato pra adquirir mais consultas." }), {
        status: 402, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    console.log(`AVALIAR_LOG [${reqId}] CREDITO_OK`);
    creditoConsumido = true; // a partir daqui, qualquer erro precisa estornar

    const tAntesAnthropic = Date.now();
    console.log(`AVALIAR_LOG [${reqId}] ANTHROPIC_INICIO ts=${new Date(tAntesAnthropic).toISOString()}`);

    // ===== tentarAvaliacaoComIA() =====
    // Faz UMA chamada à IA e tenta extrair o resultado estruturado.
    // Detecta truncamento em DOIS casos, como pedido: (a) stop_reason ===
    // "max_tokens", OU (b) falha ao interpretar o tool_use/JSON retornado
    // (a IA não chamou a tool E o texto solto também não tem um JSON
    // válido/completo - sinal de que a geração foi cortada no meio de
    // qualquer jeito, mesmo sem max_tokens explícito). Não decide sozinha
    // se deve tentar de novo - só reporta o que encontrou pro chamador.
    async function tentarAvaliacaoComIA(promptTexto, maxTokensDaTentativa, tentativaNum) {
      const conteudoMensagem = temFotos
        ? [
            ...fotos.map((f) => ({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.base64 } })),
            { type: "text", text: promptTexto },
          ]
        : promptTexto;

      let anthropicRes;
      try {
        // V15 (Fase 2): atributos extras relevantes pra ESSA categoria —
        // pega do ranking_importancia que o frontend já manda, descartando
        // os que já têm campo fixo (potência/ano/peso/rpm). Se o frontend
        // não mandar ranking_importancia (ex: chamada antiga/Lote sem essa
        // atualização), a lista fica vazia e a tool se comporta exatamente
        // como a V14 — sem quebrar nada que já funcionava.
        const atributosExtraRelevantes = Array.isArray(item.ranking_importancia)
          ? item.ranking_importancia.filter((attr) => !MAPA_ATRIBUTO_PARA_CAMPO_ITEM[attr])
          : [];
        anthropicRes = await chamarAIProvider({
          conteudoMensagem,
          tools: [
            { type: "web_search_20250305", name: "web_search" },
            construirAvaliacaoTool(atributosExtraRelevantes),
          ],
          maxTokens: maxTokensDaTentativa,
        });
      } catch (fetchErr) {
        console.log(`AVALIAR_LOG [${reqId}] ANTHROPIC_FETCH_EXCEPTION tentativa=${tentativaNum} erro="${fetchErr && fetchErr.message || String(fetchErr)}"`);
        throw fetchErr; // exceção de rede/timeout do AbortController não é "truncamento" - continua subindo igual antes
      }

      if (!anthropicRes.ok) {
        const bodyText = await anthropicRes.text();
        console.log(`AVALIAR_LOG [${reqId}] ANTHROPIC_ERRO tentativa=${tentativaNum} status=${anthropicRes.status} body_preview="${bodyText.slice(0, 300)}"`);
        return { tipo: "erro_http", status: anthropicRes.status, bodyText };
      }

      const data = await anthropicRes.json();
      console.log(`AVALIAR_LOG [${reqId}] ANTHROPIC_RESPOSTA_OK tentativa=${tentativaNum} tamanho_bytes_aprox=${JSON.stringify(data).length} stop_reason=${data.stop_reason}`);

      const truncadaPorMaxTokens = data.stop_reason === "max_tokens";
      if (truncadaPorMaxTokens) {
        console.log(`AVALIAR_LOG [${reqId}] RESPOSTA_TRUNCADA tentativa=${tentativaNum} motivo="stop_reason_max_tokens"`);
      }

      const blocosToolUse = (data.content || []).filter((b) => b.type === "tool_use");
      const toolAvaliacao = blocosToolUse.find((b) => b.name === "reportar_avaliacao");

      if (toolAvaliacao && toolAvaliacao.input && !truncadaPorMaxTokens) {
        console.log(`AVALIAR_LOG [${reqId}] TOOL_CALL tentativa=${tentativaNum} ok=true campos=${Object.keys(toolAvaliacao.input).join(",")}`);
        return { tipo: "sucesso", resultado: toolAvaliacao.input };
      }

      if (truncadaPorMaxTokens) {
        return { tipo: "truncado", motivo: "stop_reason_max_tokens" };
      }

      // --- Fallback: a IA não chamou a tool, tenta achar JSON no texto ---
      console.log(`AVALIAR_LOG [${reqId}] TOOL_CALL tentativa=${tentativaNum} ok=false motivo="ia_nao_chamou_a_tool" caindo_no_fallback_de_texto`);
      const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
      const jsonBalanceado = extrairJsonBalanceado(clean);

      if (!jsonBalanceado) {
        // não achou tool_use válido NEM JSON balanceado no texto - trata
        // como truncamento também (falha de interpretação, regra 5b do pedido)
        console.log(`AVALIAR_LOG [${reqId}] PARSE_JSON tentativa=${tentativaNum} ok=false erro="nenhum_json_balanceado_encontrado" texto_preview="${clean.slice(0, 300)}"`);
        return { tipo: "truncado", motivo: "falha_ao_interpretar_tool_use_ou_json" };
      }
      try {
        const resultadoFallback = JSON.parse(jsonBalanceado);
        console.log(`AVALIAR_LOG [${reqId}] PARSE_JSON tentativa=${tentativaNum} ok=true(fallback_balanceado)`);
        return { tipo: "sucesso", resultado: resultadoFallback };
      } catch (parseErr) {
        // JSON foi encontrado mas não fechou/não é válido - mesmo motivo,
        // trata como truncamento (falha de interpretação, regra 5b)
        console.log(`AVALIAR_LOG [${reqId}] PARSE_JSON tentativa=${tentativaNum} ok=false erro="${parseErr.message}" texto_preview="${jsonBalanceado.slice(0, 300)}"`);
        return { tipo: "truncado", motivo: "falha_ao_interpretar_tool_use_ou_json" };
      }
    }

    // Tentativa 1: prompt normal, max_tokens=5000
    let tentativa = await tentarAvaliacaoComIA(buildPrompt(item, temFotos), 5000, 1);
    let usouFallbackCondensado = false;

    // Tentativa 2 (só acontece se a 1ª truncou, por qualquer um dos 2
    // motivos): prompt condensado, max_tokens=2500. NÃO consome crédito de
    // novo - consumir_credito já foi chamado 1x antes da tentativa 1; as
    // duas tentativas reaproveitam o mesmo crédito já debitado.
    if (tentativa.tipo === "truncado") {
      console.log(`AVALIAR_LOG [${reqId}] TENTANDO_FALLBACK_CONDENSADO motivo="${tentativa.motivo}"`);
      usouFallbackCondensado = true;
      tentativa = await tentarAvaliacaoComIA(buildPromptCondensado(item, temFotos), 2500, 2);
    }

    if (tentativa.tipo === "erro_http") {
      console.log(`AVALIAR_LOG [${reqId}] FIM caminho=anthropic_web_search resultado=erro_http duracao_total_ms=${Date.now() - tInicioTotal}`);
      await estornarSeNecessario("IA respondeu erro HTTP " + tentativa.status);
      return new Response(JSON.stringify({ error: `IA falhou (${tentativa.status}): ${tentativa.bodyText}` }), {
        status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (tentativa.tipo === "truncado") {
      // só chega aqui se a tentativa 2 (condensada) TAMBÉM truncou/falhou
      console.log(`AVALIAR_LOG [${reqId}] FIM caminho=anthropic_web_search resultado=truncado_apos_fallback duracao_total_ms=${Date.now() - tInicioTotal}`);
      await estornarSeNecessario("Resposta da IA cortada mesmo após tentativa condensada");
      return new Response(JSON.stringify({ error: "Não foi possível concluir a avaliação. A resposta foi cortada no meio (item complexo demais para uma única resposta). Tente novamente." }), {
        status: 408, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const resultado = tentativa.resultado;
    if (usouFallbackCondensado) {
      console.log(`AVALIAR_LOG [${reqId}] SUCESSO_APOS_FALLBACK_CONDENSADO`);
    }
    resultado.origem = "ia";

    // ===== validarComparavel() (PRIORIDADE MÁXIMA) =====
    // Corrige a raiz da contaminação da base própria: até aqui, um
    // comparável era salvo em observacoes_mercado usando o categoria_id do
    // ITEM PESQUISADO, não do comparável em si - permitindo que um
    // vibrador/redutor/compressor ficasse salvo como "motor_eletrico" só
    // porque apareceu como resultado de busca pra um motor.
    //
    // Cada comparável passa por 4 regras obrigatórias (validarComparavel,
    // definida acima): categoria (sinal da IA + sobreposição textual),
    // marca normalizada, modelo presente, score >= 50. Falhou qualquer
    // regra -> descartado ANTES de dedup/outlier/qualidade, nunca chega a
    // ser persistido nem conta no cálculo. Quem passa já sai com a marca
    // normalizada aplicada, usada tanto na resposta ao usuário quanto no
    // que é salvo.
    const marcaAliasesMap = await carregarMarcaAliasesServidor();
    console.log(`AVALIAR_LOG [${reqId}] VALIDAR_COMPARAVEL_INICIO categoria_item="${item.categoria || ""}" qtd_comparaveis=${resultado.comparaveis ? resultado.comparaveis.length : 0} aliases_carregados=${Object.keys(marcaAliasesMap).length}`);
    const scoresValidados = {};
    if (resultado.comparaveis && resultado.comparaveis.length > 0) {
      const antesValidacao = resultado.comparaveis.length;
      resultado.comparaveis = resultado.comparaveis.filter((c) => {
        const { valido, marcaNormalizada, score } = validarComparavel(item, c, marcaAliasesMap, reqId);
        if (valido) {
          c.marca = marcaNormalizada; // marca normalizada passa a valer tanto na resposta quanto no salvamento
          scoresValidados[c.titulo + "|" + c.preco] = score; // reaproveitado no salvamento, evita recalcular
        }
        return valido;
      });
      console.log(`AVALIAR_LOG [${reqId}] VALIDAR_COMPARAVEL_FIM antes=${antesValidacao} depois=${resultado.comparaveis.length} descartados=${antesValidacao - resultado.comparaveis.length}`);
    }

    // ===== Deduplicação de comparáveis =====
    // Mesmo anúncio não deve contar 2x (ex: a IA achou o mesmo anúncio em
    // duas buscas diferentes, ou uma reprint em dois marketplaces com texto
    // quase idêntico). Considera duplicata quando título normalizado E preço
    // batem - critério conservador de propósito, pra não descartar
    // comparáveis genuinamente diferentes por engano.
    const qtdAntesDedup = resultado.comparaveis ? resultado.comparaveis.length : 0;
    if (resultado.comparaveis && resultado.comparaveis.length > 1) {
      const vistos = new Set();
      resultado.comparaveis = resultado.comparaveis.filter((c) => {
        const chave = normalizarTexto(c.titulo || "") + "|" + Math.round(Number(c.preco) || 0);
        if (vistos.has(chave)) return false;
        vistos.add(chave);
        return true;
      });
    }
    const qtdAposDedup = resultado.comparaveis ? resultado.comparaveis.length : 0;

    // ===== Detecção de resultados ruins (v15) =====
    // Sai: sem preço, locação/aluguel, abaixo de R$100 (depois de converter
    // a moeda) e moeda estrangeira sem cotação disponível. Cada comparável
    // ganha _precoBRL (usado nas contas) sem mexer no preço original
    // (que é salvo junto com a moeda real).
    const cotacoesIA = await buscarCotacoes();
    const descartesIA = { sem_preco: 0, locacao: 0, preco_baixo: 0, sem_cotacao: 0 };
    if (resultado.comparaveis) {
      resultado.comparaveis = resultado.comparaveis.filter((c) => {
        const preco = Number(c.preco);
        if (!preco || isNaN(preco) || preco <= 0) { descartesIA.sem_preco++; return false; }
        if (ehLocacao(c.tipo_mercado, c.titulo)) { descartesIA.locacao++; return false; }
        const valor = converterParaBRL(preco, c.moeda, cotacoesIA);
        if (valor === null) { descartesIA.sem_cotacao++; return false; }
        if (valor < PRECO_MINIMO_BRL) { descartesIA.preco_baixo++; return false; }
        c._precoBRL = valor;
        c._estrangeiro = normalizarMoeda(c.moeda) !== "BRL";
        c._leilao = ehLeilao(c.tipo_mercado, c.titulo);
        c._estadoClasse = estadoNovoOuUsado([c.estado, c.titulo].filter(Boolean).join(" "));
        return true;
      });
    }
    const qtdAposFiltroQualidade = resultado.comparaveis ? resultado.comparaveis.length : 0;
    console.log(`AVALIAR_LOG [${reqId}] FILTRO_QUALIDADE_V15 descartes=${JSON.stringify(descartesIA)} restantes=${qtdAposFiltroQualidade}`);

    // Leilão só alimenta a faixa de leilão; venda direta alimenta a faixa principal.
    const comparaveisLeilao = (resultado.comparaveis || []).filter((c) => c._leilao);
    let comparaveisVenda = (resultado.comparaveis || []).filter((c) => !c._leilao);

    // Novo só com novo / usado só com usado — quando houver pelo menos 2 do
    // mesmo estado do item; senão mantém todos (melhor que zerar a faixa).
    const classeItem = estadoNovoOuUsado(item.estado);
    const mesmoEstado = comparaveisVenda.filter((c) => c._estadoClasse === classeItem);
    if (mesmoEstado.length >= 2 && mesmoEstado.length < comparaveisVenda.length) {
      console.log(`AVALIAR_LOG [${reqId}] FILTRO_ESTADO item=${classeItem} antes=${comparaveisVenda.length} depois=${mesmoEstado.length}`);
      comparaveisVenda = mesmoEstado;
    }

    // ===== Detecção de outliers =====
    // Mesma removerOutliersPorPreco() da base própria, agora sobre o preço
    // já convertido para R$ (só nos de venda, que formam a faixa).
    let qtdOutliersRemovidos = 0;
    if (comparaveisVenda.length >= 4) {
      const envelopados = comparaveisVenda.map((c) => ({ preco: c._precoBRL, ref: c }));
      const { itens, removidos } = removerOutliersPorPreco(envelopados, reqId, "ia");
      comparaveisVenda = itens.map((e) => e.ref);
      qtdOutliersRemovidos = removidos;
    }

    // ===== Confidence Score objetivo (substitui a "opinião" textual da IA) =====
    // Alta/Média/Baixa calculada a partir de critérios objetivos, não do que
    // a IA "acha" que é confiável.
    function calcularConfiancaAvaliacao(comparaveis) {
      if (!comparaveis || comparaveis.length === 0) return "baixa";
      const precos = comparaveis.map((c) => Number(c._precoBRL ?? c.preco)).filter((n) => !isNaN(n) && n > 0);
      if (precos.length === 0) return "baixa";
      const min = Math.min(...precos);
      const max = Math.max(...precos);
      const dispersao = min > 0 ? max / min : 999;
      const temModeloExato = comparaveis.some((c) => c.compatibilidade === "alta");
      const qtdAlta = comparaveis.filter((c) => c.compatibilidade === "alta").length;
      if (comparaveis.length >= 4 && qtdAlta >= 2 && dispersao < 2) return "alta";
      if (comparaveis.length >= 3 && (temModeloExato || dispersao < 3)) return "média";
      return "baixa";
    }
    resultado.confianca_avaliacao = calcularConfiancaAvaliacao(comparaveisVenda);

    // Recalcula a faixa a partir dos comparáveis de venda que sobraram.
    // Estrangeiro entra na média com peso 0,25 e fica fora do mín/máx quando
    // há 3+ nacionais.
    if (comparaveisVenda.length > 0) {
      const nacionais = comparaveisVenda.filter((c) => !c._estrangeiro);
      const baseFaixa = nacionais.length >= 3 ? nacionais : comparaveisVenda;
      const precosFaixa = baseFaixa.map((c) => c._precoBRL);
      const minFinal = Math.min(...precosFaixa);
      const maxFinal = Math.max(...precosFaixa);
      const pesos = comparaveisVenda.map((c) => (c._estrangeiro ? PESO_PRECO_ESTRANGEIRO : 1));
      const somaPesos = pesos.reduce((a, b) => a + b, 0);
      const mediaFinal = comparaveisVenda.reduce((acc, c, i) => acc + c._precoBRL * pesos[i], 0) / (somaPesos || 1);
      resultado.faixa_min = Math.round(minFinal);
      resultado.faixa_max = Math.round(maxFinal);
      resultado.faixa_media = Math.round(Math.min(Math.max(mediaFinal, minFinal), maxFinal));
    }
    // Faixa de leilão: com 2+ leilões reais, usa eles; senão mantém a da IA.
    if (comparaveisLeilao.length >= 2) {
      const precosLeilao = comparaveisLeilao.map((c) => c._precoBRL);
      resultado.leilao_min = Math.round(Math.min(...precosLeilao));
      resultado.leilao_max = Math.round(Math.max(...precosLeilao));
    }
    // se não sobrou nenhum comparável de venda, mantém a faixa original que
    // a IA calculou (melhor que zerar tudo) - mas sinaliza baixa confiança.
    if (comparaveisVenda.length === 0) {
      resultado.confianca_avaliacao = "baixa";
    }
    // O que volta pra tela e é salvo: venda usada no cálculo + leilões.
    resultado.comparaveis = [...comparaveisVenda, ...comparaveisLeilao];

    // ===== Explicabilidade em funil =====
    // "Como chegamos nesse valor" de forma estruturada e auditável, não só
    // texto solto - "8 encontrados → 6 sem duplicata → 5 com preço válido →
    // 4 dentro da distribuição normal".
    resultado.funil_comparaveis = {
      encontrados: qtdAntesDedup,
      apos_deduplicacao: qtdAposDedup,
      apos_filtro_qualidade: qtdAposFiltroQualidade,
      outliers_removidos: qtdOutliersRemovidos,
      usados_no_calculo: comparaveisVenda.length,
      leiloes: comparaveisLeilao.length,
    };
    console.log(`AVALIAR_LOG [${reqId}] FUNIL_COMPARAVEIS ${JSON.stringify(resultado.funil_comparaveis)} confianca=${resultado.confianca_avaliacao}`);

    let comparaveisSalvos = 0;
    if (resultado.comparaveis && resultado.comparaveis.length > 0) {
      const rows = resultado.comparaveis.map((c) => {
        // V15 (Fase 2): antes só gravava potencia_cv/ano/peso_kg (faltavam
        // potencia_kw/rpm, que já eram campos fixos) - e nada dos atributos
        // extra por categoria (tensão, capacidade, vazão etc.), que agora
        // a IA pode reportar em c.atributos_extra. Tipo mudou pra aceitar
        // texto também (ex: tensão "380/660" não é um número só).
        const atributos: Record<string, number | string> = {};
        if (c.potencia_cv) atributos.potencia_cv = c.potencia_cv;
        if (c.potencia_kw) atributos.potencia_kw = c.potencia_kw;
        if (c.ano) atributos.ano = c.ano;
        if (c.peso_kg) atributos.peso_kg = c.peso_kg;
        if (c.rpm) atributos.rpm = c.rpm;
        if (c.atributos_extra && typeof c.atributos_extra === "object") {
          Object.assign(atributos, c.atributos_extra);
        }
        // v15: tensão nunca vira modelo; motor sempre com combustível
        if (item.categoria_id === "motor_eletrico" && !atributos.combustivel) {
          atributos.combustivel = detectarCombustivel([c.titulo, c.modelo].filter(Boolean).join(" ")) || combustivelDoItem(item);
        }
        delete atributos.modelo;
        const scoreComparavel = scoresValidados[c.titulo + "|" + c.preco] ?? calcularScoreCompatibilidade(item, { marca: c.marca, estado: c.estado, atributos_normalizados: atributos }, item.ranking_importancia);
        return {
          categoria: item.categoria || null,
          categoria_id: item.categoria_id || null,
          marca: c.marca || null,
          modelo: modeloCurto(c.modelo),
          preco: c.preco ?? null,
          moeda: normalizarMoeda(c.moeda),
          estado: c._estadoClasse || estadoNovoOuUsado(c.estado),
          tipo_mercado: c._leilao ? "Leilão" : "Venda Direta",
          data_observacao: new Date().toISOString().slice(0, 10),
          atributos_normalizados: Object.keys(atributos).length > 0 ? atributos : null,
          score_compatibilidade: scoreComparavel,
        };
      });
      const { data: inseridos, error: erroInsert } = await supabase.from("observacoes_mercado").insert(rows).select("id");
      if (erroInsert) {
        // score_compatibilidade pode ainda não existir se a migration não
        // rodou - tenta de novo sem essa coluna, pra não perder o salvamento
        // inteiro por causa de uma coluna nova opcional.
        console.log(`AVALIAR_LOG [${reqId}] SALVAR_COMPARAVEIS_ERRO_TENTANDO_SEM_SCORE erro="${erroInsert.message}"`);
        const rowsSemScore = rows.map(({ score_compatibilidade, ...resto }) => resto);
        const { data: inseridos2 } = await supabase.from("observacoes_mercado").insert(rowsSemScore).select("id");
        comparaveisSalvos = inseridos2 ? inseridos2.length : 0;
      } else {
        comparaveisSalvos = inseridos ? inseridos.length : 0;
        // Proveniência (URL/título original) fica numa tabela separada -
        // são dados que identificam a FONTE, não o valuation em si. Algumas
        // fontes podem ter restrição sobre exposição/reprodução desses dados,
        // então ficam à parte, com acesso mais restrito (só service role).
        // Resiliente: se a tabela ainda não existir (migration não rodada),
        // só loga e segue - não quebra o salvamento principal.
        try {
          const linhasProveniencia = inseridos.map((row, i) => ({
            observacao_id: row.id,
            url: resultado.comparaveis[i].url || null,
            titulo_original: resultado.comparaveis[i].titulo || null,
          })).filter((l) => l.url || l.titulo_original);
          if (linhasProveniencia.length > 0) {
            await supabase.from("observacoes_proveniencia").insert(linhasProveniencia);
          }
        } catch (provErr) {
          console.log(`AVALIAR_LOG [${reqId}] PROVENIENCIA_FALHOU erro="${provErr && provErr.message || String(provErr)}"`);
        }
      }
      console.log(`AVALIAR_LOG [${reqId}] SALVOU_COMPARAVEIS qtd=${comparaveisSalvos} com_marca=${rows.filter((r) => r.marca).length} com_atributos=${rows.filter((r) => r.atributos_normalizados).length}`);
    }

    // Telemetria (pré-requisito pra qualquer decisão futura sobre trocar de
    // provider) - best-effort, não quebra a resposta se a tabela não existir
    // ainda ou se o insert falhar por qualquer motivo.
    const evaluationId = crypto.randomUUID();
    console.log(`AVALIAR_LOG [${reqId}] EVALUATION_ID ${evaluationId}`);
    try {
      await supabase.from("avaliacoes_telemetria").insert({
        evaluation_id: evaluationId,
        usuario_id: userData.user.id,
        categoria_id: item.categoria_id || null,
        origem: "ia",
        ai_provider: "claude",
        search_provider: "claude_web_search",
        cache_hit: false,
        qtd_comparaveis_encontrados: resultado.comparaveis ? resultado.comparaveis.length : 0,
        qtd_comparaveis_apos_filtro: comparaveisSalvos,
        tempo_total_ms: Date.now() - tInicioTotal,
        sucesso: true,
        resultado_snapshot: resultado,
        versao_motor: VERSAO_MOTOR,
        versao_prompt: VERSAO_PROMPT,
      });
    } catch (telemetriaErr) {
      console.log(`AVALIAR_LOG [${reqId}] TELEMETRIA_FALHOU erro="${telemetriaErr && telemetriaErr.message || String(telemetriaErr)}"`);
    }

    console.log(`AVALIAR_LOG [${reqId}] FIM caminho=anthropic_web_search resultado=sucesso duracao_total_ms=${Date.now() - tInicioTotal}`);

    // campos internos (_precoBRL etc.) não vão para a tela
    resultado.comparaveis = (resultado.comparaveis || []).map((c) => {
      const { _precoBRL, _estrangeiro, _leilao, _estadoClasse, ...publico } = c;
      // a tela mostra preco como R$: devolve convertido e guarda o original
      const moeda = normalizarMoeda(c.moeda);
      return {
        ...publico,
        preco: Math.round(_precoBRL),
        ...(moeda !== "BRL" ? { preco_original: c.preco, moeda_original: moeda } : {}),
        moeda: "BRL",
        tipo_mercado: _leilao ? "Leilão" : "Venda Direta",
        estado: _estadoClasse,
      };
    });

    return new Response(JSON.stringify(resultado), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.log(`AVALIAR_LOG [${reqId}] EXCECAO_GERAL erro="${err && err.message || String(err)}" duracao_total_ms=${Date.now() - tInicioTotal}`);
    console.error("PRECIFICAI_ERRO_GERAL:", err.message || String(err));
    await estornarSeNecessario("Erro inesperado: " + (err && err.message || String(err)));
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});