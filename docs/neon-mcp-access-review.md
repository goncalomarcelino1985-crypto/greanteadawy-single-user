# Revisão de acesso Neon MCP

Data: 29/10/2026. O relatório específico do projeto fica fora do repositório público; `PROJECT_ID` representa o projeto indicado pelo utilizador.

**Conclusão:** não retomar o OAuth amplo como solução de privilégio mínimo. `projectId`, `readonly`, `category` e `roleName` impõem limites reais dentro do servidor MCP, mas não reduzem os scopes Neon pedidos na autorização upstream. O código devolve ao cliente o próprio token de acesso upstream. Uma configuração MCP restrita não equivale, portanto, a uma credencial Neon restrita ao projeto ou apenas de leitura.

Esta revisão não autorizou OAuth, criou credenciais, executou SQL ou alterou recursos cloud. Baseia-se em documentação oficial, leitura do repositório público e na pré-visualização pública descrita abaixo. Não prova que o serviço remoto executa exatamente o commit analisado, nem substitui testes autenticados de autorização.

## Fonte e versão

Repositório oficial `neondatabase/mcp-server-neon`, commit [`cd24cc172f7e8c22a78bd28ec93fcf28466b47f5`](https://github.com/neondatabase/mcp-server-neon/commit/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5), de 28/10/2026, obtido sem autenticação. Os links de código abaixo fixam essa versão. A [documentação Neon MCP](https://neon.com/docs/ai/neon-mcp-server) distingue configuração por projeto, modo de leitura, categorias e papel Postgres, e alerta para as capacidades amplas de gestão.

## Duas camadas de autorização diferentes

| Camada | Evidência no código | Consequência |
| --- | --- | --- |
| OAuth Neon upstream | `NEON_MCP_SCOPES` inclui criação, leitura, atualização e eliminação de projetos e organizações, permissões de organização e acesso offline. `upstreamAuth()` usa sempre essa lista. | Os parâmetros do URL MCP não diminuem esse consentimento. [Fonte](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/lib/oauth/client.ts#L116). |
| Token entregue ao cliente | `/api/token` guarda `authorizationCode.token.access_token` como `accessToken` e devolve esse mesmo valor. O grant e os scopes MCP ficam em campos separados. | Não existe aqui um token opaco novo cuja autoridade esteja limitada ao grant MCP. [Fonte](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/app/api/token/route.ts#L736). |
| Uso fora do MCP | O próprio verificador documenta que os tokens OAuth MCP também passam na autenticação da API Neon; o grant restrito existe no armazenamento do MCP. | Inferência de segurança: possuir o bearer permite tentar acesso direto à API Neon, fora dos filtros MCP, sujeito aos scopes upstream e permissões da conta. Não foi feito esse teste com uma conta real. [Fonte](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/app/api/%5Btransport%5D/route.ts#L1101). |

Os scopes públicos `read`/`write` anunciados pelo servidor MCP são desta segunda camada; não descrevem, por si só, o consentimento upstream da primeira.

## O que os limites MCP fazem realmente

| Limite | Proteção implementada | Limite da garantia |
| --- | --- | --- |
| `projectId` | Filtra ferramentas sem escopo de projeto; injeta o projeto autorizado e rejeita um `project_id` diferente. | Não fixa branch, base de dados, tabelas ou privilégios SQL. Não restringe a credencial upstream fora do MCP. [Filtro](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/grant-filter.ts#L101), [validação](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/grant-filter.ts#L303). |
| `category` | Filtra grupos de ferramentas. `send_feedback` continua disponível; outros mecanismos de descoberta também são exceções antes do filtro de projeto. | É uma seleção de categorias, não uma lista imutável de operações. Novas ferramentas podem entrar num grupo. [Fonte](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/grant-filter.ts#L12). |
| `readonly` | Filtra por `readOnlySafe`; `run_sql` usa uma transação com `readOnly: true`. | Não é apenas uma indicação ao modelo, mas também não deve ser interpretado como ausência absoluta de efeitos para todas as ferramentas. [SQL](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/tools.ts#L90). |
| `roleName` | Fixa o papel de login Postgres e rejeita `role_name` diferente. Sem pin, o login pode ser o proprietário da base. | O nome `gm_worker_reader` não cria o papel nem lhe dá permissões: estas têm de existir e ser verificadas. O pin não limita ferramentas da API de gestão. [Resolução do papel](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/handlers/connection-string.ts#L45). |

`run_sql_transaction` é excluído de leitura porque várias instruções poderiam sair da transação de leitura. `get_connection_string` também é excluído: devolver uma palavra-passe de base de dados permitiria sair dos filtros do MCP. O pin de papel retém igualmente essa ferramenta. [Definições](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/definitions.ts#L74), [credenciais](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/definitions.ts#L167).

Há uma exceção concreta ao sentido literal de «nenhuma escrita»: `describe_branch`, disponível como ferramenta segura para leitura, cria uma função auxiliar em `public`, consulta e remove-a numa transação que não recebe `readOnly: true`. Um papel restrito pode impedir a operação. Não incluir a categoria `branches` numa futura inspeção estritamente de leitura. [Implementação](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/tools/handlers/describe-branch.ts#L55).

`compare_database_schema` é calculado pela API Neon e não fica limitado pelos grants do papel SQL. Isso é explicitado pelo projeto upstream e é relevante porque a ferramenta aparece na pré-visualização restrita. [README oficial](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/README.md#L225).

## Alterar URL, reutilizar tokens e sessões

Para **OAuth**, o verificador usa o grant e os scopes guardados com o token. Alterar o URL depois da autorização não alarga esses campos. Um grant inválido é recusado; se um bearer OAuth cair no caminho de API key, o servidor recusa reconstruir o grant a partir do URL. Esta é uma proteção efetiva dentro do MCP. Para uma **API key direta**, os limites são reconstruídos a partir do URL/cabeçalho em cada pedido; o detentor da chave pode retirá-los, continuando sujeito apenas ao escopo real da chave na API Neon. [Verificação](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/app/api/%5Btransport%5D/route.ts#L1040).

Tokens antigos sem campo de grant recebem o comportamento padrão, sem projeto nem categorias fixos; não devem ser considerados restritos por mera mudança de configuração. Um `roleName` presente mas inválido falha, em vez de regressar ao proprietário. [Normalização](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/utils/grant-context.ts#L189).

A ligação de identidade das sessões SSE usa conta e cliente OAuth. Não inclui projeto, papel, modo de leitura, categorias ou hash do bearer. Para API keys da mesma conta, o cliente é sempre `api-key`. Isto impede trocas entre contas/clientes, mas não é uma ligação criptográfica ao grant individual. Não foi demonstrado um ataque entre sessões; é um limite do que o código garante. [Fonte](https://github.com/neondatabase/mcp-server-neon/blob/cd24cc172f7e8c22a78bd28ec93fcf28466b47f5/mcp/server/session-binding.ts#L161).

## Evidência pública obtida e limites

O agente principal verificou resposta HTTP 200, sem autenticação, em:

- [Metadados OAuth públicos](https://mcp.neon.tech/.well-known/oauth-authorization-server): scopes MCP `read` e `write`.
- [Pré-visualização de ferramentas](https://mcp.neon.tech/api/list-tools?readonly=true&projectId=PROJECT_ID&category=querying&category=schema&roleName=gm_worker_reader): projeto indicado, `readOnly: true` e oito ferramentas: `run_sql`, `describe_table_schema`, `get_database_tables`, `explain_sql_statement`, `list_slow_queries`, `inspect_database`, `send_feedback`, `compare_database_schema`.
- Um pedido MCP `initialize`, sem credenciais, recebeu HTTP 401. Não se tentou executar ferramentas nem obter dados do projeto.

Essa resposta prova a seleção pública apresentada pelo servidor. **Não prova** existência ou privilégios do papel, acesso à conta/projeto, validade de credenciais, enforcement autenticado, leitura SQL bem-sucedida ou rejeição real de escritas. Nenhuma dessas ferramentas foi executada nesta revisão.

## Recomendação mínima para o GM AI WORKER

1. Manter o OAuth cancelado. Não apresentar o URL parametrizado como correção para o consentimento amplo ou como credencial mínima.
2. A persistência da aplicação precisa de acesso Postgres aos seus dados, não de administração da conta Neon. Preferir futuramente uma credencial de base de dados restrita, no projeto/branch/base destinados à aplicação, com privilégios apenas necessários às suas tabelas. Separar preparação do esquema, execução da aplicação e leitura de diagnóstico; conferir privilégios reais, incluindo memberships e funções executáveis. Esta é uma recomendação de arquitetura, não uma alteração já realizada.
3. Caso administração Neon por API se torne indispensável, avaliar uma chave realmente limitada ao projeto. Segundo a [documentação de API keys](https://neon.com/docs/manage/api-keys), apenas administradores de organização a podem criar; concede acesso **Editor**, permite alterações no projeto e não é apenas leitura. Não criar uma chave pessoal ampla como substituto. Não foi verificado se a conta atual oferece essa opção.
4. Qualquer futura credencial deve entrar por um percurso seguro de segredos, sem aparecer em conversa, documentação ou repositório. Os filtros MCP seriam defesa adicional. O controlo musical deve ser fornecido pelo MCP próprio da DAW com permissões próprias, sem disponibilizar o token de administração Neon ao agente musical.
5. Não considerar a persistência cloud validada antes de testar, com acesso específico devidamente autorizado, escrita/leitura de dados sintéticos, perda completa da cache Render, restauro e rejeição de acessos fora do escopo. A revisão atual não desbloqueia essa prova nem autoriza a publicação.

Não foi pedida ou ativada qualquer subscrição, trial ou serviço pago durante esta revisão.
