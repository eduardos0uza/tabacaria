// Sistema de Gestão para Loja
class SistemaTabacaria {
    constructor() {
        this.produtos = this.carregarProdutos();
        this.carrinho = [];
        this.totalVendasDia = this.carregarTotalVendas();
        this.formaPagamento = null;
        // Configuração PIX (ajuste conforme seu banco/chave)
        this.pixConfig = this._carregarPixConfig();
        // Realtime Sync (Firebase)
        this.sync = {
            enabled: false,
            app: null,
            auth: null,
            db: null,
            user: null,
            config: null
        };
        // Índice e coalescência de renderizações
        this._prodIndex = new Map();
        this._saveTimers = {};
        this._coalesce = { filtrosTimer: null };
        // Gestão de vendedores
        this.vendedores = this.carregarVendedores();
        this.vendedorSelecionado = null;
        this.filtroVendedoresStatus = 'todos';
        this.inicializar();
    }

    // ===== Utilitários de performance =====
    _debounce(fn, wait = 120) {
        let t;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => {
                try { fn.apply(this, args); } catch (e) { console.error('Erro debounce:', e); }
            }, wait);
        };
    }

    _scheduleSave(key, fn, wait = 100) {
        try {
            clearTimeout(this._saveTimers[key]);
        } catch (_) {}
        this._saveTimers[key] = setTimeout(() => {
            try { fn(); } catch (e) { console.error('Erro save agendado', key, e); }
            delete this._saveTimers[key];
        }, wait);
    }

    _rebuildProdIndex() {
        try {
            this._prodIndex = new Map();
            (this.produtos || []).forEach(p => this._prodIndex.set(p.id, p));
        } catch (e) { console.error('Erro ao reindexar produtos:', e); }
    }

    getProdutoById(id) {
        if (!this._prodIndex || !this._prodIndex.has(id)) this._rebuildProdIndex();
        return this._prodIndex.get(id) || null;
    }

    inicializar() {
        this.atualizarRelogio();
        this.carregarProdutosSelect();
        this.atualizarEstoque();
        // Garantir lista do estoque visível ao iniciar
        this.aplicarFiltrosCombinados('estoque-lista');
        this.atualizarListaProdutos();
        // Inicializar filtros e autocomplete de produtos
        this.inicializarFiltrosProdutos();
        this.atualizarTotalVendas();
        this.atualizarRelatorios();
        this.inicializarDatasRelatorio();
        const badgeInit = document.getElementById('payment-selected-badge');
        if (badgeInit) {
            badgeInit.style.display = 'none';
            badgeInit.textContent = 'Forma: —';
        }
        const vendorBadgeInit = document.getElementById('vendor-selected-badge');
        if (vendorBadgeInit) {
            vendorBadgeInit.style.display = 'none';
            vendorBadgeInit.textContent = 'Vendedor: —';
        }
        // Inicializar vendedores na UI
        this.carregarVendedoresSelect();
        // Inicializar select de vendedores na aba Relatórios
        this.carregarVendedoresSelectRelatorio();
        // Restaurar vendedor previamente selecionado no caixa
        this.restaurarVendedorSelecionado();
        this.atualizarListaVendedores();
        const vendedorSelect = document.getElementById('vendedor-select');
        if (vendedorSelect) {
            vendedorSelect.addEventListener('change', (e) => this.selecionarVendedor(e.target.value));
        }
        
        // Atualizar relógio a cada segundo
        setInterval(() => this.atualizarRelogio(), 1000);
        
        // Event listeners
        document.getElementById('produto-select').addEventListener('change', this.atualizarPrecoUnitario.bind(this));
        const valorRecebidoEl = document.getElementById('valor-recebido');
        if (valorRecebidoEl) {
            valorRecebidoEl.addEventListener('input', this._debounce(() => this.calcularTroco(), 120));
        }
        
        // Event listeners e inicialização de filtros de produtos
        this.inicializarFiltrosProdutos();
        const searchProdutos = document.getElementById('search-produtos');
        if (searchProdutos) {
            searchProdutos.addEventListener('input', this._debounce(() => this.aplicarFiltrosCombinados('produtos-lista'), 150));
        }
        
        // Event listeners para cálculo de margem
        const custoInput = document.getElementById('produto-custo');
        const precoInput = document.getElementById('produto-preco');
        
        if (custoInput) custoInput.addEventListener('input', () => this.calcularMargemLucro());
        if (precoInput) precoInput.addEventListener('input', () => this.calcularMargemLucro());
        
        // Atualizar estatísticas de produtos
        this.atualizarEstatisticasProdutos();
        // Preparar dados para Entrada Rápida se existir
        const entradaSelect = document.getElementById('entrada-produto');
        if (entradaSelect) {
            this._popularEntradaRapidaSelect();
            this.inicializarEntradaRapidaInteracoes();
        }

        // Atualização automática da seção "Movimentações Recentes" quando houver novos registros
        document.addEventListener('movimentos_atualizados', () => {
            if (typeof this.renderizarMovimentacoesRecentes === 'function') {
                this.renderizarMovimentacoesRecentes();
            }
        });

        // Inicializar sincronização em tempo real (se configurada)
        this._initRealtimeSync();

        // Atalhos globais (navegação e ações rápidas)
        document.addEventListener('keydown', (e) => {
            const key = (e.key || '').toLowerCase();
            const target = e.target || e.srcElement;
            const isInputEl = target && ((target.tagName === 'INPUT') || (target.tagName === 'TEXTAREA') || target.isContentEditable);
            if (e.ctrlKey && key === 'k') {
                e.preventDefault();
                this.abrirCommandPalette();
            }
            if (!e.ctrlKey && !e.altKey && !e.metaKey) {
                if (isInputEl) return; // não interferir enquanto digitando em campos
                if (key === 'i') { // Entrada (remapeado para I)
                    showTab('estoque');
                    this.setTipoMovRapido('entrada');
                    this.focarEntradaRapida();
                } else if (key === 's') { // Saída
                    showTab('estoque');
                    this.setTipoMovRapido('saida');
                    this.focarEntradaRapida();
                } else if (key === 'e') { // Cadastro rápido de produto
                    showTab('produtos');
                    const n = document.getElementById('produto-nome');
                    if (n) { try { n.scrollIntoView({behavior:'smooth',block:'center'}); } catch(_){} n.focus(); }
                }
            }
            if (e.ctrlKey && key === 'enter') {
                const overlay = document.getElementById('cmdk-overlay');
                if (overlay && overlay.style.display === 'block') return; // evita confirmar com paleta aberta
                e.preventDefault();
                this.confirmarEntradaRapida();
            }
        });
    }

    // ====== Realtime Sync (Firebase) ======
    _initRealtimeSync() {
        try {
            const cfg = this._obterFirebaseConfig();
            if (!cfg || !cfg.projectId) {
                console.warn('Firebase não configurado. Mantendo modo local.');
                return;
            }
            if (typeof firebase === 'undefined') {
                console.warn('Bibliotecas Firebase não carregadas.');
                return;
            }
            this.sync.config = cfg;
            this.sync.app = firebase.initializeApp(cfg);
            this.sync.auth = firebase.auth();
            this.sync.db = firebase.firestore();
            // Persistência offline
            if (this.sync.db && this.sync.db.enablePersistence) {
                this.sync.db.enablePersistence().catch(() => {});
            }
            // Autenticação anônima por padrão
            this.sync.auth.signInAnonymously().then((cred) => {
                this.sync.user = cred.user;
                this.sync.enabled = true;
                console.log('Sync habilitado (usuário anônimo).');
                // Listeners principais
                this._listenRemoteProdutos();
                this._listenRemoteMovimentos();
                this._listenRemoteVendas();
            }).catch(err => {
                console.error('Falha ao autenticar (anon):', err);
            });
        } catch (e) {
            console.error('Erro ao inicializar sync:', e);
        }
    }

    _obterFirebaseConfig() {
        try {
            const local = localStorage.getItem('firebase_config');
            if (local) return JSON.parse(local);
        } catch (_) {}
        if (typeof window !== 'undefined' && window.FIREBASE_CONFIG) return window.FIREBASE_CONFIG;
        return null;
    }

    configurarFirebase(config) {
        try {
            if (!config || !config.projectId) throw new Error('Config Firebase inválida');
            localStorage.setItem('firebase_config', JSON.stringify(config));
            this.mostrarToast('Sync', 'Configuração Firebase salva. Recarregue a página.', 'success');
        } catch (e) {
            console.error('Erro ao salvar config Firebase:', e);
            this.mostrarToast('Erro ao salvar configuração Firebase.', 'error');
        }
    }

    _listenRemoteProdutos() {
        if (!this.sync.enabled) return;
        try {
            this.sync.db.collection('produtos').onSnapshot((snap) => {
                const arr = [];
                snap.forEach(doc => arr.push(doc.data()));
                if (Array.isArray(arr) && arr.length) {
                    this.produtos = this._normalizarProdutos(arr);
                    if (typeof this._rebuildProdIndex === 'function') {
                        try { this._rebuildProdIndex(); } catch (_) {}
                    }
                    this.atualizarListaProdutos();
                    this.atualizarEstoque();
                    this.atualizarEstatisticasProdutos();
                    this.atualizarRelatorios();
                }
            }, (err) => console.error('Falha listener produtos:', err));
        } catch (e) { console.error('Erro ao ouvir produtos:', e); }
    }

    _normalizarProdutos(produtos) {
        return (produtos || []).map(p => ({
            ...p,
            codigo: p.codigo || '',
            fornecedor: p.fornecedor || '',
            minimo: Number.isFinite(p.minimo) ? p.minimo : 0,
            descricao: p.descricao || '',
            localizacao: p.localizacao || ''
        }));
    }

    _listenRemoteMovimentos() {
        if (!this.sync.enabled) return;
        try {
            this.sync.db.collection('movimentos').orderBy('data', 'desc').limit(250).onSnapshot((snap) => {
                const arr = [];
                snap.forEach(doc => arr.push(doc.data()));
                this._scheduleSave('historico_movimentos', () => localStorage.setItem('historico_movimentos', JSON.stringify(arr)), 120);
                try { document.dispatchEvent(new CustomEvent('movimentos_atualizados')); } catch (_) {}
                if (typeof this.renderizarMovimentacoesRecentes === 'function') {
                    this.renderizarMovimentacoesRecentes();
                }
            }, (err) => console.error('Falha listener movimentos:', err));
        } catch (e) { console.error('Erro ao ouvir movimentos:', e); }
    }

    _listenRemoteVendas() {
        if (!this.sync.enabled) return;
        try {
            this.sync.db.collection('vendas').orderBy('data', 'desc').limit(250).onSnapshot((snap) => {
                const arr = [];
                snap.forEach(doc => arr.push(doc.data()));
                this._scheduleSave('historico_vendas', () => localStorage.setItem('historico_vendas', JSON.stringify(arr)), 120);
                // Atualizar relatórios quando vendas mudam
                try { if (typeof this.atualizarRelatorios === 'function') this.atualizarRelatorios(); } catch (_) {}
            }, (err) => console.error('Falha listener vendas:', err));
        } catch (e) { console.error('Erro ao ouvir vendas:', e); }
    }

    _syncUpsertProdutos(lista) {
        if (!this.sync.enabled) return;
        try {
            const batch = this.sync.db.batch();
            (lista || []).forEach(p => {
                const id = String(p.id || p.codigo || Math.random().toString(36).slice(2));
                const ref = this.sync.db.collection('produtos').doc(id);
                const payload = {
                    ...p,
                    id,
                    updatedAt: (firebase.firestore && firebase.firestore.FieldValue && firebase.firestore.FieldValue.serverTimestamp && firebase.firestore.FieldValue.serverTimestamp()) || new Date(),
                    updatedBy: (this.sync.user && this.sync.user.uid) || 'anon'
                };
                batch.set(ref, payload, { merge: true });
            });
            batch.commit().catch(err => console.error('Falha batch produtos:', err));
        } catch (e) { console.error('Erro upsert produtos:', e); }
    }

    _syncAdjustStock(produtoId, delta) {
        if (!this.sync.enabled) return;
        try {
            const ref = this.sync.db.collection('produtos').doc(String(produtoId));
            const inc = (firebase.firestore && firebase.firestore.FieldValue && firebase.firestore.FieldValue.increment) ? firebase.firestore.FieldValue.increment(delta) : delta;
            const payload = {
                estoque: inc,
                updatedAt: (firebase.firestore && firebase.firestore.FieldValue && firebase.firestore.FieldValue.serverTimestamp && firebase.firestore.FieldValue.serverTimestamp()) || new Date()
            };
            ref.set(payload, { merge: true }).catch(err => console.error('Falha ajuste estoque remoto:', err));
        } catch (e) { console.error('Erro _syncAdjustStock:', e); }
    }

    _syncAdd(collection, payload) {
        if (!this.sync.enabled) return;
        try {
            const meta = {
                userId: (this.sync.user && this.sync.user.uid) || 'anon',
                vendedorId: (this.vendedorSelecionado && this.vendedorSelecionado.id) || null,
                createdAt: (firebase.firestore && firebase.firestore.FieldValue && firebase.firestore.FieldValue.serverTimestamp && firebase.firestore.FieldValue.serverTimestamp()) || new Date(),
            };
            this.sync.db.collection(collection).add({ ...payload, _meta: meta }).catch(err => console.error('Falha add', collection, err));
        } catch (e) { console.error('Erro _syncAdd:', e); }
    }

    _carregarPixConfig() {
        try {
            const raw = localStorage.getItem('pix_config');
            if (raw) return JSON.parse(raw);
        } catch (_) {}
        // Valores padrão — edite conforme necessário
        const def = {
            chave: 'email@exemplo.com',
            nomeRecebedor: 'Seu Nome',
            cidade: 'SUA CIDADE',
            info: 'Pagamento de produtos',
            banco: 'Seu Banco'
        };
        try { localStorage.setItem('pix_config', JSON.stringify(def)); } catch (_) {}
        return def;
    }

    // Define e persiste a chave PIX do recebedor
    definirPixChave(chave) {
        try {
            if (!chave || typeof chave !== 'string') {
                console.warn('Chave PIX inválida fornecida.');
                return;
            }
            // Normaliza CPF/CNPJ/Telefone removendo caracteres não numéricos; mantém e-mail/EVP como está
            const isEmail = chave.includes('@');
            const normalizada = isEmail ? chave.trim() : chave.replace(/\D+/g, '');
            this.pixConfig = { ...(this.pixConfig || {}), chave: normalizada };
            try { localStorage.setItem('pix_config', JSON.stringify(this.pixConfig)); } catch (_) {}
            // Feedback ao usuário
            if (typeof this.mostrarToast === 'function') {
                try {
                    // this.mostrarToast('PIX', 'Chave atualizada com sucesso.', 'success');
                } catch (e) {
                    // Compatibilidade com possível assinatura alternativa
                    // this.mostrarToast('Chave PIX atualizada com sucesso.', 'success');
                }
            }
            // Re-renderiza se a seção PIX estiver visível
            const pixSection = document.getElementById('pix-section');
            if (pixSection && pixSection.style.display === 'block') {
                this.renderizarPix();
            }
        } catch (e) {
            console.error('Erro ao atualizar a chave PIX:', e);
        }
    }

    // Define e persiste o nome e a cidade do recebedor PIX
    definirPixRecebedor(nome, cidade) {
        try {
            const novoNome = (nome || '').trim().slice(0, 25);
            const novaCidade = (cidade || '').trim().slice(0, 15);

            this.pixConfig = { 
                ...(this.pixConfig || {}), 
                nomeRecebedor: novoNome, 
                cidade: novaCidade 
            };

            try { localStorage.setItem('pix_config', JSON.stringify(this.pixConfig)); } catch (_) {}

            if (typeof this.mostrarToast === 'function') {
                // this.mostrarToast('PIX', 'Nome e cidade atualizados.', 'success');
            }

            // Re-renderiza se a seção PIX estiver visível
            const pixSection = document.getElementById('pix-section');
            if (pixSection && pixSection.style.display === 'block') {
                this.renderizarPix();
            }
        } catch (e) {
            console.error('Erro ao atualizar nome/cidade do PIX:', e);
        }
    }

    // Gera payload EMV BR Code para PIX
    gerarPayloadPix({ valor, chave, nomeRecebedor, cidade, info = '', txid = '' }) {
        const tag = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;
        const mica = (sub) => tag('26', sub.join(''));
        const mSub = [
            tag('00', 'br.gov.bcb.pix'),
            tag('01', chave),
            ...(info ? [tag('02', info)] : [])
        ];
        const addDataField = (sub) => tag('62', sub.join(''));
        const adfSub = [
            tag('05', txid || 'TX' + Date.now())
        ];
        const base = [
            tag('00', '01'), // Payload Format Indicator
            tag('01', '11'), // Point of Initiation Method (static)
            mica(mSub),
            tag('52', '0000'), // MCC
            tag('53', '986'), // BRL
            ...(valor ? [tag('54', Number(valor).toFixed(2))] : []),
            tag('58', 'BR'),
            tag('59', (nomeRecebedor || '').slice(0, 25)),
            tag('60', (cidade || '').slice(0, 15)),
            addDataField(adfSub)
        ].join('');
        const full = base + '6304';
        const crc = this._crc16(full).toUpperCase();
        return base + tag('63', crc);
    }

    _crc16(str) {
        // CRC16/CCITT-FALSE
        let crc = 0xFFFF;
        for (let i = 0; i < str.length; i++) {
            crc ^= (str.charCodeAt(i) << 8);
            for (let j = 0; j < 8; j++) {
                if ((crc & 0x8000) !== 0) crc = (crc << 1) ^ 0x1021;
                else crc = (crc << 1);
                crc &= 0xFFFF;
            }
        }
        return crc.toString(16).padStart(4, '0');
    }

    // Renderiza QR e Copia e Cola para PIX
    renderizarPix() {
        const total = this.carrinho.reduce((t, i) => t + (i.preco * i.quantidade), 0);
        const { chave, nomeRecebedor, cidade, info } = this.pixConfig || {};
        const txid = 'V' + Date.now();
        const payload = this.gerarPayloadPix({ valor: total, chave, nomeRecebedor, cidade, info, txid });
        const codeEl = document.getElementById('pix-code');
        if (codeEl) codeEl.value = payload;
        const canvas = document.getElementById('pix-qr');
        if (canvas && window.QRCode) {
            try {
                window.QRCode.toCanvas(canvas, payload, { width: 180, margin: 1 }, (err) => {
                    if (err) console.error('Falha ao gerar QR:', err);
                });
            } catch (e) { console.warn('QR lib indisponível:', e); }
        }
    }

    copiarPix() {
        const codeEl = document.getElementById('pix-code');
        if (!codeEl || !codeEl.value) { this.mostrarToast('Código PIX indisponível.', 'error'); return; }
        navigator.clipboard.writeText(codeEl.value).then(() => {
            this.mostrarToast('Código copiado para a área de transferência.', 'success');
        }).catch(() => {
            this.mostrarToast('Não foi possível copiar o código.', 'error');
        });
    }

    regerarPix() {
        this.renderizarPix();
    }

    carregarProdutos() {
        const produtosSalvos = localStorage.getItem('produtos');
        let produtos;
        if (produtosSalvos) {
            try {
                produtos = JSON.parse(produtosSalvos) || [];
            } catch (e) {
                produtos = [];
            }
        } else {
            // Produtos padrão para demonstração
            produtos = [
                { id: 1, nome: 'Coca-Cola 350ml', preco: 5.00, custo: 3.00, estoque: 50, categoria: 'bebidas' },
                { id: 2, nome: 'Batata Frita', preco: 2.50, custo: 1.50, estoque: 30, categoria: 'salgados' },
                { id: 3, nome: 'Cigarro Marlboro', preco: 12.50, custo: 8.00, estoque: 25, categoria: 'cigarros' },
                { id: 4, nome: 'Isqueiro BIC', preco: 3.50, custo: 2.00, estoque: 40, categoria: 'outros' },
                { id: 5, nome: 'Água Mineral 500ml', preco: 2.00, custo: 1.20, estoque: 60, categoria: 'bebidas' },
                { id: 6, nome: 'Chocolate Bis', preco: 4.50, custo: 2.80, estoque: 35, categoria: 'doces' }
            ];
        }

        // Normalizar para incluir novos campos
        return produtos.map(p => ({
            ...p,
            codigo: p.codigo || '',
            fornecedor: p.fornecedor || '',
            minimo: Number.isFinite(p.minimo) ? p.minimo : 0,
            descricao: p.descricao || '',
            localizacao: p.localizacao || ''
        }));
    }

    salvarProdutos() {
        this._scheduleSave('produtos', () => localStorage.setItem('produtos', JSON.stringify(this.produtos)), 120);
        // Sync remoto
        this._syncUpsertProdutos(this.produtos);
    }

    salvarDados() {
        this.salvarProdutos();
    }

    // ==== Gestão de Vendedores ====
    carregarVendedores() {
        try {
            const dados = localStorage.getItem('vendedores');
            return dados ? JSON.parse(dados) : [];
        } catch (e) {
            console.error('Erro ao carregar vendedores:', e);
            return [];
        }
    }

    salvarVendedores() {
        try {
            localStorage.setItem('vendedores', JSON.stringify(this.vendedores));
        } catch (e) {
            console.error('Erro ao salvar vendedores:', e);
        }
    }

    carregarVendedoresSelect() {
        const select = document.getElementById('vendedor-select');
        if (!select) return;
        // Resetar opções
        select.innerHTML = '<option value="">👤 Escolha o vendedor...</option>';
        this.vendedores.forEach(v => {
            const opt = document.createElement('option');
            opt.value = String(v.id);
            opt.textContent = v.nome + (v.contato ? ` — ${v.contato}` : '') + (v.status && v.status !== 'ativo' ? ` (${v.status})` : '');
            select.appendChild(opt);
        });
        // Manter seleção atual
        if (this.vendedorSelecionado) {
            select.value = String(this.vendedorSelecionado.id);
        }
    }

    carregarVendedoresSelectRelatorio() {
        const select = document.getElementById('vendedor-relatorio-select');
        if (!select) return;
        select.innerHTML = '<option value="">Todos os vendedores</option>';
        this.vendedores.forEach(v => {
            const opt = document.createElement('option');
            opt.value = String(v.id);
            opt.textContent = v.nome + (v.contato ? ` — ${v.contato}` : '') + (v.status && v.status !== 'ativo' ? ` (${v.status})` : '');
            select.appendChild(opt);
        });
    }

    selecionarVendedor(id) {
        const badge = document.getElementById('vendor-selected-badge');
        if (!id) {
            this.vendedorSelecionado = null;
            if (badge) {
                badge.textContent = 'Vendedor: —';
                badge.style.display = 'none';
            }
            return;
        }
        const vendedor = this.vendedores.find(v => String(v.id) === String(id));
        this.vendedorSelecionado = vendedor || null;
        // Persistir seleção atual
        this.salvarVendedorSelecionado();
        if (badge) {
            if (this.vendedorSelecionado) {
                badge.textContent = `Vendedor: ${this.vendedorSelecionado.nome}`;
                badge.style.display = 'inline-flex';
            } else {
                badge.textContent = 'Vendedor: —';
                badge.style.display = 'none';
            }
        }
    }

    salvarVendedorSelecionado() {
        try {
            const id = this.vendedorSelecionado ? String(this.vendedorSelecionado.id) : '';
            localStorage.setItem('vendedor_selecionado', id);
        } catch (e) {
            console.error('Erro ao salvar vendedor selecionado:', e);
        }
    }

    restaurarVendedorSelecionado() {
        try {
            const id = localStorage.getItem('vendedor_selecionado');
            if (id) {
                // Garantir que selects estejam carregados
                this.selecionarVendedor(id);
                const select = document.getElementById('vendedor-select');
                if (select) select.value = String(id);
            }
        } catch (e) {
            console.error('Erro ao restaurar vendedor selecionado:', e);
        }
    }

    cadastrarVendedor() {
        const nomeInput = document.getElementById('vendedor-nome');
        const contatoInput = document.getElementById('vendedor-contato');
        const statusSelect = document.getElementById('vendedor-status');
        if (!nomeInput) return;
        const nome = (nomeInput.value || '').trim();
        const contato = (contatoInput && contatoInput.value) ? contatoInput.value.trim() : '';
        const status = (statusSelect && statusSelect.value) ? statusSelect.value : 'ativo';
        if (!nome) {
            this.mostrarModal('Erro', 'Informe o nome do vendedor!', 'error');
            return;
        }
        const novoVendedor = {
            id: Date.now(),
            nome,
            contato: contato || null,
            status
        };
        this.vendedores.push(novoVendedor);
        this.salvarVendedores();
        this.carregarVendedoresSelect();
        this.carregarVendedoresSelectRelatorio();
        this.atualizarListaVendedores();
        // Selecionar automaticamente o novo vendedor
        this.selecionarVendedor(novoVendedor.id);
        // Limpar formulário
        nomeInput.value = '';
        if (contatoInput) contatoInput.value = '';
        if (statusSelect) statusSelect.value = 'ativo';
        this.mostrarToast('👤 Vendedor cadastrado com sucesso!', 'success');
    }

    excluirVendedor(id) {
        const idNum = Number(id);
        this.vendedores = this.vendedores.filter(v => Number(v.id) !== idNum);
        // Se o vendedor selecionado foi removido
        if (this.vendedorSelecionado && Number(this.vendedorSelecionado.id) === idNum) {
            this.vendedorSelecionado = null;
            const select = document.getElementById('vendedor-select');
            if (select) select.value = '';
            const badge = document.getElementById('vendor-selected-badge');
            if (badge) { badge.textContent = 'Vendedor: —'; badge.style.display = 'none'; }
        }
        this.salvarVendedores();
        this.carregarVendedoresSelect();
        this.carregarVendedoresSelectRelatorio();
        this.atualizarListaVendedores();
        this.mostrarToast('🗑️ Vendedor removido!', 'success');
    }

    alterarStatusVendedor(id, novoStatus) {
        const vendedor = this.vendedores.find(v => Number(v.id) === Number(id));
        if (!vendedor) return;
        const statusAnterior = vendedor.status || 'ativo';
        vendedor.status = novoStatus;
        this.salvarVendedores();
        // Atualizar selects dependentes e UI
        this.carregarVendedoresSelect();
        this.carregarVendedoresSelectRelatorio();
        this.atualizarListaVendedores();
        // Feedback
        const emoji = novoStatus === 'ativo' ? '✅' : novoStatus === 'ferias' ? '🏖️' : '⛔';
        this.mostrarToast(`${emoji} Status alterado: ${statusAnterior.toUpperCase()} → ${novoStatus.toUpperCase()}`, 'success');
    }

    // Abrir modal para edição de vendedor
    abrirModalEditarVendedor(id) {
        const vendedor = this.vendedores.find(v => Number(v.id) === Number(id));
        if (!vendedor) {
            this.mostrarModal('Erro', 'Vendedor não encontrado!', 'error');
            return;
        }
        const modal = document.getElementById('modal');
        const body = document.getElementById('modal-body');
        if (!modal || !body) return;

        body.innerHTML = `
            <div class="notification-header warning">
                <div class="notification-icon warning">✏️</div>
                <h3 class="notification-title">Editar Vendedor</h3>
            </div>
            <div class="notification-body">
                <form id="form-editar-vendedor" class="premium-form" onsubmit="event.preventDefault(); salvarEdicaoVendedor(${vendedor.id});">
                    <div class="form-row">
                        <div class="input-group">
                            <label for="edit-vendedor-nome">Nome</label>
                            <div class="input-wrapper">
                                <input type="text" id="edit-vendedor-nome" value="${vendedor.nome}" required autocomplete="name">
                                <span class="input-icon">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6l3 1 1 3L7 9l3-3 1-1 1 1 3 3-1 1-3 3-1-1-3-1-1-3z"/></svg>
                                </span>
                            </div>
                            <div class="validation-message"></div>
                        </div>
                        <div class="input-group">
                            <label for="edit-vendedor-contato">Contato</label>
                            <div class="input-wrapper">
                                <input type="text" id="edit-vendedor-contato" value="${vendedor.contato || ''}" autocomplete="tel">
                                <span class="input-icon">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92V19a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2 5.18 2 2 0 0 1 4 3h2.09a2 2 0 0 1 2 1.72c.12.81.31 1.6.57 2.34a2 2 0 0 1-.45 2.11L7.21 10a16 16 0 0 0 6 6l.83-.83a2 2 0 0 1 2.11-.45c.74.26 1.53.45 2.34.57A2 2 0 0 1 22 16.92z"/></svg>
                                </span>
                            </div>
                        </div>
                        <div class="input-group">
                            <label for="edit-vendedor-status">Status</label>
                            <div class="select-wrapper">
                                <select id="edit-vendedor-status">
                                    <option value="ativo" ${((vendedor.status||'ativo')==='ativo')?'selected':''}>Ativo</option>
                                    <option value="ferias" ${((vendedor.status||'ativo')==='ferias')?'selected':''}>Férias</option>
                                    <option value="inativo" ${((vendedor.status||'ativo')==='inativo')?'selected':''}>Inativo</option>
                                </select>
                                <div class="select-icon">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/></svg>
                                </div>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
            <div class="notification-actions">
                <button class="btn-notification secondary" onclick="fecharModal()">Cancelar</button>
                <button class="btn-notification primary" onclick="salvarEdicaoVendedor(${vendedor.id})">Salvar</button>
            </div>
        `;
        modal.style.display = 'block';
    }
    
    // Abrir modal para edição de vendedor
    abrirModalEditarVendedor(id) {
        const vendedor = this.vendedores.find(v => Number(v.id) === Number(id));
        if (!vendedor) {
            this.mostrarModal('Erro', 'Vendedor não encontrado!', 'error');
            return;
        }
        const modal = document.getElementById('modal');
        const body = document.getElementById('modal-body');
        if (!modal || !body) return;

        body.innerHTML = `
            <div class="notification-header warning">
                <div class="notification-icon warning">✏️</div>
                <h3 class="notification-title">Editar Vendedor</h3>
            </div>
            <div class="notification-body">
                <form id="form-editar-vendedor" class="premium-form" onsubmit="event.preventDefault(); salvarEdicaoVendedor(${vendedor.id});">
                    <div class="form-row">
                        <div class="input-group">
                            <label for="edit-vendedor-nome">Nome</label>
                            <div class="input-wrapper">
                                <input type="text" id="edit-vendedor-nome" value="${vendedor.nome}" required autocomplete="name">
                                <span class="input-icon">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6l3 1 1 3L7 9l3-3 1-1 1 1 3 3-1 1-3 3-1-1-3-1-1-3z"/></svg>
                                </span>
                            </div>
                            <div class="validation-message"></div>
                        </div>
                        <div class="input-group">
                            <label for="edit-vendedor-contato">Contato</label>
                            <div class="input-wrapper">
                                <input type="text" id="edit-vendedor-contato" value="${vendedor.contato || ''}" autocomplete="tel">
                                <span class="input-icon">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92V19a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2 5.18 2 2 0 0 1 4 3h2.09a2 2 0 0 1 2 1.72c.12.81.31 1.6.57 2.34a2 2 0 0 1-.45 2.11L7.21 10a16 16 0 0 0 6 6l.83-.83a2 2 0 0 1 2.11-.45c.74.26 1.53.45 2.34.57A2 2 0 0 1 22 16.92z"/></svg>
                                </span>
                            </div>
                        </div>
                        <div class="input-group">
                            <label for="edit-vendedor-status">Status</label>
                            <div class="select-wrapper">
                                <select id="edit-vendedor-status">
                                    <option value="ativo" ${((vendedor.status||'ativo')==='ativo')?'selected':''}>Ativo</option>
                                    <option value="ferias" ${((vendedor.status||'ativo')==='ferias')?'selected':''}>Férias</option>
                                    <option value="inativo" ${((vendedor.status||'ativo')==='inativo')?'selected':''}>Inativo</option>
                                </select>
                                <div class="select-icon">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/></svg>
                                </div>
                            </div>
                        </div>
                    </div>
                </form>
            </div>
            <div class="notification-actions">
                <button class="btn-notification secondary" onclick="fecharModal()">Cancelar</button>
                <button class="btn-notification primary" onclick="salvarEdicaoVendedor(${vendedor.id})">Salvar</button>
            </div>
        `;
        modal.style.display = 'block';
    }

    // Salvar alterações do vendedor
    salvarEdicaoVendedor(id) {
        const nomeInput = document.getElementById('edit-vendedor-nome');
        const contatoInput = document.getElementById('edit-vendedor-contato');
        const statusSelect = document.getElementById('edit-vendedor-status');
        const nome = (nomeInput && nomeInput.value || '').trim();
        const contato = (contatoInput && contatoInput.value || '').trim();
        const status = (statusSelect && statusSelect.value) ? statusSelect.value : 'ativo';
        if (!nome) {
            this.mostrarModal('Erro', 'Informe o nome do vendedor!', 'error');
            return;
        }
        const vendedor = this.vendedores.find(v => Number(v.id) === Number(id));
        if (!vendedor) {
            this.mostrarModal('Erro', 'Vendedor não encontrado!', 'error');
            return;
        }
        vendedor.nome = nome;
        vendedor.contato = contato || null;
        vendedor.status = status;
        this.salvarVendedores();
        this.carregarVendedoresSelect();
        this.carregarVendedoresSelectRelatorio();
        this.atualizarListaVendedores();
        // Atualizar badge se o vendedor editado estiver selecionado
        if (this.vendedorSelecionado && Number(this.vendedorSelecionado.id) === Number(id)) {
            const badge = document.getElementById('vendor-selected-badge');
            if (badge) {
                badge.textContent = `Vendedor: ${vendedor.nome}`;
                badge.style.display = 'inline-flex';
            }
            this.salvarVendedorSelecionado();
        }
        fecharModal();
        this.mostrarModal('Sucesso', 'Vendedor atualizado!', 'success');
    }
    atualizarListaVendedores() {
        const lista = document.getElementById('vendedores-lista');
        if (!lista) return;
        const vendedoresFiltrados = (this.filtroVendedoresStatus === 'todos')
            ? this.vendedores
            : this.vendedores.filter(v => (v.status || 'ativo') === this.filtroVendedoresStatus);
        if (!vendedoresFiltrados.length) {
            lista.innerHTML = `
                <div class="vendors-empty">
                    <div class="vendors-empty-icon">👤</div>
                    <p class="vendors-empty-title">Nenhum vendedor cadastrado</p>
                    <p class="vendors-empty-sub">Adicione vendedores no formulário ao lado</p>
                </div>
            `;
            const contador = document.getElementById('contador-vendedores');
            if (contador) contador.textContent = '0 vendedores';
            return;
        }
        let html = '<div class="vendors-grid">';
        vendedoresFiltrados.forEach(v => {
            const iniciais = v.nome.split(' ').slice(0,2).map(p=>p[0]).join('').toUpperCase();
            html += `
                <div class="vendor-card">
                    <div class="vendor-avatar">${iniciais}</div>
                    <div class="vendor-details">
                        <div class="vendor-title">${v.nome}</div>
                        ${v.contato ? `<div class="vendor-sub">${v.contato}</div>` : '<div class="vendor-sub">—</div>'}
                    </div>
                    <div class="vendor-actions">
                        <span class="vendor-status-badge ${v.status || 'ativo'}">${(v.status || 'ativo').toUpperCase()}</span>
                        <select class="vendor-status-select" onchange="alterarStatusVendedor(${v.id}, this.value)">
                            <option value="ativo" ${((v.status||'ativo')==='ativo')?'selected':''}>Ativo</option>
                            <option value="ferias" ${((v.status||'ativo')==='ferias')?'selected':''}>Férias</option>
                            <option value="inativo" ${((v.status||'ativo')==='inativo')?'selected':''}>Inativo</option>
                        </select>
                        <button class="btn-outline" onclick="editarVendedor(${v.id})">Editar</button>
                        <button class="btn-outline" onclick="excluirVendedor(${v.id})">Excluir</button>
                    </div>
                </div>
            `;
        });
        html += '</div>';
        lista.innerHTML = html;
        const contador = document.getElementById('contador-vendedores');
        if (contador) {
            const qtd = vendedoresFiltrados.length;
            contador.textContent = `${qtd} ${qtd === 1 ? 'vendedor' : 'vendedores'}`;
        }
    }

    filtrarVendedoresStatus(status, elemento = null) {
        this.filtroVendedoresStatus = status;
        // Atualiza abas ativas se botão for passado
        if (elemento) {
            const tabs = document.querySelectorAll('#vendedores-filter-tabs .filter-tab-novo');
            tabs.forEach(tab => tab.classList.remove('active'));
            elemento.classList.add('active');
        }
        this.atualizarListaVendedores();
    }

    // Função para ajustar quantidade no formulário
    adjustFormQuantity(inputId, change) {
        const input = document.getElementById(inputId);
        if (!input) return;
        
        const currentValue = parseInt(input.value) || 0;
        const newValue = Math.max(0, currentValue + change);
        input.value = newValue;
        
        // Trigger change event para atualizar cálculos
        input.dispatchEvent(new Event('input'));
    }

    // Função para calcular margem de lucro
    calcularMargemLucro() {
        const custoInput = document.getElementById('produto-custo');
        const precoInput = document.getElementById('produto-preco');
        const margemElement = document.getElementById('margem-lucro');
        
        if (!custoInput || !precoInput || !margemElement) return;
        
        const custo = parseFloat(custoInput.value) || 0;
        const preco = parseFloat(precoInput.value) || 0;
        
        if (custo > 0 && preco > 0) {
            const margem = ((preco - custo) / preco) * 100;
            margemElement.textContent = `${margem.toFixed(1)}%`;
            
            // Alterar cor baseado na margem
            const margemValue = margemElement.parentElement;
            if (margem < 10) {
                margemValue.style.background = 'rgba(231, 76, 60, 0.1)';
                margemValue.style.borderColor = 'rgba(231, 76, 60, 0.2)';
                margemElement.style.color = '#e74c3c';
            } else if (margem < 30) {
                margemValue.style.background = 'rgba(243, 156, 18, 0.1)';
                margemValue.style.borderColor = 'rgba(243, 156, 18, 0.2)';
                margemElement.style.color = '#f39c12';
            } else {
                margemValue.style.background = 'rgba(46, 204, 113, 0.1)';
                margemValue.style.borderColor = 'rgba(46, 204, 113, 0.2)';
                margemElement.style.color = '#2ecc71';
            }
        } else {
            margemElement.textContent = '0%';
        }
    }

    // Função para validar campo
    validarCampo(input, mensagem = '') {
        const validationMessage = input.parentElement.querySelector('.validation-message');
        if (!validationMessage) return true;
        
        if (mensagem) {
            validationMessage.textContent = mensagem;
            input.style.borderColor = '#e74c3c';
            return false;
        } else {
            validationMessage.textContent = '';
            input.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            return true;
        }
    }

    // Função para atualizar estatísticas de produtos
    atualizarEstatisticasProdutos() {
        const totalProdutosEl = document.getElementById('total-produtos');
        const produtosBaixoEstoqueEl = document.getElementById('produtos-baixo-estoque');
        const valorTotalEstoqueEl = document.getElementById('valor-total-estoque');
        const produtosTabBadgeEl = document.getElementById('produtos-tab-badge');

        const totalProdutos = this.produtos.length;
        const baixoEstoque = this.produtos.filter(p => {
            const threshold = (Number.isFinite(p.minimo) && p.minimo > 0) ? p.minimo : 5;
            return p.estoque > 0 && p.estoque <= threshold;
        }).length;
        const valorTotal = this.produtos.reduce((total, produto) => total + (produto.custo * produto.estoque), 0);

        if (totalProdutosEl) totalProdutosEl.textContent = totalProdutos;
        if (produtosBaixoEstoqueEl) produtosBaixoEstoqueEl.textContent = baixoEstoque;
        if (valorTotalEstoqueEl) valorTotalEstoqueEl.textContent = `R$ ${valorTotal.toFixed(2).replace('.', ',')}`;
        if (produtosTabBadgeEl) produtosTabBadgeEl.textContent = String(totalProdutos);
    }

    carregarTotalVendas() {
        const hoje = new Date().toDateString();
        const vendas = localStorage.getItem(`vendas_${hoje}`);
        return vendas ? parseFloat(vendas) : 0;
    }

    salvarTotalVendas() {
        const hoje = new Date().toDateString();
        this._scheduleSave(`vendas_${hoje}`, () => localStorage.setItem(`vendas_${hoje}`, this.totalVendasDia.toString()), 120);
    }

    atualizarRelogio() {
        const agora = new Date();
        const tempo = agora.toLocaleTimeString('pt-BR');
        document.getElementById('current-time').textContent = tempo;
    }

    atualizarTotalVendas() {
        document.getElementById('total-vendas').textContent = `Total do Dia: R$ ${this.totalVendasDia.toFixed(2).replace('.', ',')}`;
    }

    carregarProdutosSelect() {
        const select = document.getElementById('produto-select');
        select.innerHTML = '<option value="">🔍 Buscar produto...</option>';
        
        this.produtos.forEach(produto => {
            const disponivel = (produto.estoque ?? produto.quantidade ?? 0);
            if (disponivel > 0) {
                const option = document.createElement('option');
                option.value = produto.id;
                option.textContent = `${produto.nome} - R$ ${produto.preco.toFixed(2).replace('.', ',')}`;
                select.appendChild(option);
            }
        });
        
        // Event listener para quantidade
        const quantidadeInput = document.getElementById('quantidade');
        if (quantidadeInput) {
            quantidadeInput.addEventListener('input', atualizarTotalItem);
        }
        
        // Atualizar lista de produtos na aba produtos
        this.atualizarListaProdutos();
        this.atualizarEstatisticasProdutos();
    }

    atualizarPrecoUnitario() {
        const select = document.getElementById('produto-select');
        const precoSpan = document.getElementById('preco-unitario');
        
        if (select.value) {
            const produto = this.produtos.find(p => p.id == select.value);
            precoSpan.textContent = `R$ ${produto.preco.toFixed(2).replace('.', ',')}`;
            atualizarTotalItem();
        } else {
            precoSpan.textContent = 'R$ 0,00';
            document.getElementById('total-item').textContent = 'R$ 0,00';
        }
    }

    adicionarItem() {
        const select = document.getElementById('produto-select');
        const quantidade = parseInt(document.getElementById('quantidade').value) || 1;
        
        if (!select.value) {
            this.mostrarModal('Erro', 'Selecione um produto!', 'error');
            return;
        }

        const produto = this.produtos.find(p => p.id == select.value);
        
        if (!produto) {
            this.mostrarModal('Erro', 'Produto não encontrado!', 'error');
            return;
        }
        
        const estoqueDisponivel = (produto.estoque ?? produto.quantidade ?? 0);
        
        if (quantidade > estoqueDisponivel) {
            this.mostrarModal('Erro', `Estoque insuficiente! Disponível: ${estoqueDisponivel}`, 'error');
            return;
        }

        // Verificar se o produto já está no carrinho
        const itemExistente = this.carrinho.find(item => item.id === produto.id);
        
        if (itemExistente) {
            if (itemExistente.quantidade + quantidade > estoqueDisponivel) {
                this.mostrarModal('Erro', `Estoque insuficiente! Disponível: ${estoqueDisponivel}`, 'error');
                return;
            }
            itemExistente.quantidade += quantidade;
        } else {
            this.carrinho.push({
                id: produto.id,
                nome: produto.nome,
                preco: produto.preco,
                quantidade: quantidade
            });
        }

        this.atualizarCarrinho();
        
        // Limpar seleção
        select.value = '';
        document.getElementById('quantidade').value = 1;
        this.atualizarPrecoUnitario();
    }

    removerItem(id) {
        this.carrinho = this.carrinho.filter(item => item.id !== id);
        this.atualizarCarrinho();
    }

    atualizarCarrinho() {
        const lista = document.getElementById('carrinho-lista');
        const total = document.getElementById('total-carrinho');
        const subtotal = document.getElementById('subtotal');
        const itemCount = document.getElementById('item-count');
        const finalizarBtn = document.getElementById('finalizar-venda');
        
        if (this.carrinho.length === 0) {
            lista.innerHTML = `
                <div class="empty-cart">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="9" cy="21" r="1"/>
                        <circle cx="20" cy="21" r="1"/>
                        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
                    </svg>
                    <p>Carrinho vazio</p>
                    <small>Adicione produtos para começar</small>
                </div>
            `;
            total.textContent = '0,00';
            if (subtotal) subtotal.textContent = 'R$ 0,00';
            if (itemCount) itemCount.textContent = '0 itens';
            if (finalizarBtn) finalizarBtn.disabled = true;
            return;
        }

        let html = '';
        let totalCompra = 0;
        let totalItens = 0;

        this.carrinho.forEach(item => {
            const subtotalItem = item.preco * item.quantidade;
            totalCompra += subtotalItem;
            totalItens += item.quantidade;
            
            html += `
                <div class="carrinho-item">
                    <div class="carrinho-item-info">
                        <div class="carrinho-item-nome">${item.nome}</div>
                        <div class="carrinho-item-detalhes">${item.quantidade}x R$ ${item.preco.toFixed(2).replace('.', ',')}</div>
                    </div>
                    <div class="carrinho-item-preco">R$ ${subtotalItem.toFixed(2).replace('.', ',')}</div>
                    <button class="remove-btn" onclick="sistema.removerItem(${item.id})">🗑️</button>
                </div>
            `;
        });

        lista.innerHTML = html;
        total.textContent = totalCompra.toFixed(2).replace('.', ',');
        if (subtotal) subtotal.textContent = `R$ ${totalCompra.toFixed(2).replace('.', ',')}`;
        if (itemCount) itemCount.textContent = `${totalItens} ${totalItens === 1 ? 'item' : 'itens'}`;
        if (finalizarBtn) finalizarBtn.disabled = (this.carrinho.length === 0 || !this.formaPagamento);
        
        // Recalcular troco se necessário
        if (this.formaPagamento === 'dinheiro') {
            this.calcularTroco();
        }
    }

    selecionarPagamento(tipo, elemento = null) {
        // Remover seleção anterior
        const buttons = document.querySelectorAll('.payment-btn');
        buttons.forEach(btn => btn.classList.remove('selected'));

        // Mapear texto do botão pela forma de pagamento
        const labelMap = {
            'dinheiro': 'Dinheiro',
            'credito': 'Cartão de Crédito',
            'debito': 'Cartão de Débito',
            'pix': 'PIX'
        };

        // Determinar botão alvo sem depender de event
        let targetBtn = elemento;
        if (!targetBtn) {
            const expectedLabel = labelMap[tipo] || '';
            targetBtn = Array.from(buttons).find(btn => btn.innerText.trim().includes(expectedLabel)) || null;
        }
        if (!targetBtn && typeof event !== 'undefined' && event?.target) {
            targetBtn = event.target;
        }
        if (targetBtn) {
            targetBtn.classList.add('selected');
        }

        // Atualizar forma de pagamento
        this.formaPagamento = tipo;

        // Atualizar badge de forma de pagamento selecionada
        const badge = document.getElementById('payment-selected-badge');
        if (badge) {
            const formas = {
                'dinheiro': 'Dinheiro',
                'credito': 'Cartão de Crédito',
                'debito': 'Cartão de Débito',
                'pix': 'PIX'
            };
            const nomeForma = formas[tipo] || tipo || '';
            if (nomeForma) {
                badge.textContent = `Forma: ${nomeForma}`;
                badge.style.display = 'inline-block';
            } else {
                badge.textContent = '';
                badge.style.display = 'none';
            }
        }

        // Mostrar/ocultar seção de dinheiro e limpar troco quando necessário
        const dinheiroSection = document.getElementById('dinheiro-section');
        const pixSection = document.getElementById('pix-section');
        const trocoInfo = document.getElementById('troco-info');
        const valorRecebidoInput = document.getElementById('valor-recebido');
        if (tipo === 'dinheiro') {
            dinheiroSection.style.display = 'block';
            if (pixSection) pixSection.style.display = 'none';
            if (valorRecebidoInput) valorRecebidoInput.focus();
            this.calcularTroco();
        } else if (tipo === 'pix') {
            dinheiroSection.style.display = 'none';
            if (pixSection) {
                pixSection.style.display = 'block';
                this.renderizarPix();
            }
            if (trocoInfo) { trocoInfo.style.display = 'none'; trocoInfo.innerHTML = ''; }
            if (valorRecebidoInput) valorRecebidoInput.value = '';
        } else {
            dinheiroSection.style.display = 'none';
            if (trocoInfo) {
                trocoInfo.style.display = 'none';
                trocoInfo.innerHTML = '';
            }
            if (valorRecebidoInput) valorRecebidoInput.value = '';
            if (pixSection) pixSection.style.display = 'none';
        }

        // Habilitar/desabilitar botão de finalizar conforme seleção
        const finalizarBtn = document.getElementById('finalizar-venda');
        if (finalizarBtn) finalizarBtn.disabled = (this.carrinho.length === 0 || !this.formaPagamento);
    }

    calcularTroco() {
        const valorRecebido = parseFloat(document.getElementById('valor-recebido').value) || 0;
        const totalCompra = this.carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
        const trocoInfo = document.getElementById('troco-info');
        
        if (valorRecebido >= totalCompra && totalCompra > 0) {
            const troco = valorRecebido - totalCompra;
            trocoInfo.innerHTML = `
                <div>💰 Troco: R$ ${troco.toFixed(2).replace('.', ',')}</div>
                ${troco > 0 ? '<div style="font-size: 14px; margin-top: 5px;">✅ Valor suficiente</div>' : '<div style="font-size: 14px; margin-top: 5px;">✅ Valor exato</div>'}
            `;
            trocoInfo.style.display = 'block';
        } else if (valorRecebido > 0) {
            const falta = totalCompra - valorRecebido;
            trocoInfo.innerHTML = `
                <div style="color: #e53e3e;">❌ Valor insuficiente</div>
                <div style="font-size: 14px; margin-top: 5px;">Falta: R$ ${falta.toFixed(2).replace('.', ',')}</div>
            `;
            trocoInfo.style.display = 'block';
        } else {
            trocoInfo.style.display = 'none';
        }
    }

    finalizarVenda() {
        if (this.carrinho.length === 0) {
            this.mostrarModal('Erro', 'Carrinho vazio!', 'error');
            return;
        }

        if (!this.formaPagamento) {
            this.mostrarModal('Erro', 'Selecione uma forma de pagamento!', 'error');
            return;
        }

        const totalCompra = this.carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
        const totalCusto = this.carrinho.reduce((total, item) => {
            const produto = this.getProdutoById(item.id);
            return total + (produto.custo * item.quantidade);
        }, 0);
        const lucroVenda = totalCompra - totalCusto;
        
        // Validar pagamento em dinheiro
        if (this.formaPagamento === 'dinheiro') {
            const valorRecebido = parseFloat(document.getElementById('valor-recebido').value) || 0;
            if (valorRecebido < totalCompra) {
                this.mostrarModal('Erro', 'Valor recebido insuficiente!', 'error');
                return;
            }
        }

        // SALVAR DADOS DA VENDA ANTES DE LIMPAR
        const vendaId = 'V' + Date.now();
        const dadosVenda = {
            id: vendaId,
            totalCompra,
            lucroVenda,
            itens: [...this.carrinho], // Criar cópia do carrinho
            formaPagamento: this.formaPagamento,
            valorRecebido: this.formaPagamento === 'dinheiro' ? parseFloat(document.getElementById('valor-recebido').value) : null,
            vendedor: this.vendedorSelecionado ? { id: this.vendedorSelecionado.id, nome: this.vendedorSelecionado.nome, contato: this.vendedorSelecionado.contato || null } : null
        };

        // Atualizar estoque
        this.carrinho.forEach(item => {
            const produto = this.getProdutoById(item.id);
            if (produto) {
                const estoqueAnterior = produto.estoque || 0;
                const quantidadeReal = Math.min(item.quantidade, estoqueAnterior);
                produto.estoque = estoqueAnterior - quantidadeReal;
                // Garantir que o estoque não fique negativo
                if (produto.estoque < 0) {
                    produto.estoque = 0;
                }

                // Registrar movimento de saída por venda
                this.registrarMovimentoEstoque({
                    id: 'M' + Date.now() + '-' + produto.id,
                    data: new Date().toISOString(),
                    tipo: 'saida',
                    origem: 'venda',
                    vendaId,
                    produtoId: produto.id,
                    nome: produto.nome,
                    codigo: produto.codigo || '',
                    categoria: produto.categoria || 'outros',
                    fornecedor: produto.fornecedor || '',
                    quantidade: quantidadeReal,
                    estoqueAntes: estoqueAnterior,
                    estoqueDepois: produto.estoque,
                    precoUnitario: item.preco,
                    custoUnitario: produto.custo
                });
            }
        });

        // Registrar venda no histórico
        this.registrarVenda({
            id: vendaId,
            data: new Date().toISOString(),
            itens: [...this.carrinho],
            totalVenda: totalCompra,
            totalCusto: totalCusto,
            lucro: lucroVenda,
            formaPagamento: this.formaPagamento,
            vendedor: this.vendedorSelecionado ? { id: this.vendedorSelecionado.id, nome: this.vendedorSelecionado.nome, contato: this.vendedorSelecionado.contato || null } : null
        });

        // Atualizar total de vendas
        this.totalVendasDia += totalCompra;
        
        // Salvar dados
        this.salvarProdutos();
        this.salvarTotalVendas();
        // Atualizar movimentações recentes imediatamente após finalizar venda
        if (typeof this.renderizarMovimentacoesRecentes === 'function') {
            this.renderizarMovimentacoesRecentes();
        }
        
        // Mostrar toast de feedback rápido
         this.mostrarToast(`💰 Venda de R$ ${totalCompra.toFixed(2).replace('.', ',')} finalizada!`, 'success', 2500);
         
        // Limpar venda ANTES de mostrar o modal
        this.carrinho = [];
        this.formaPagamento = null;
        document.getElementById('valor-recebido').value = '';
        document.querySelectorAll('.payment-btn').forEach(btn => btn.classList.remove('selected'));
        document.getElementById('dinheiro-section').style.display = 'none';
        // Limpar badge de forma de pagamento
        const badge = document.getElementById('payment-selected-badge');
        if (badge) {
            badge.textContent = '';
            badge.style.display = 'none';
        }
        
        // Atualizar interface
        this.atualizarCarrinho();
        this.carregarProdutosSelect();
        this.atualizarEstoque();
        this.atualizarTotalVendas();
        this.atualizarRelatorios();
        atualizarEstatisticas();
         
         // Mostrar modal detalhado com os dados salvos
         setTimeout(() => {
             this.mostrarModalVenda(dadosVenda);
         }, 500);
    }

    registrarVenda(venda) {
        const hoje = new Date().toDateString();
        let vendas = JSON.parse(localStorage.getItem('historico_vendas') || '[]');
        vendas.push(venda);
        this._scheduleSave('historico_vendas', () => localStorage.setItem('historico_vendas', JSON.stringify(vendas)), 150);
        // Sync remoto
        this._syncAdd('vendas', venda);
    }

    // Registro e consulta de movimentos de estoque
    registrarMovimentoEstoque(movimento) {
        let movimentos = [];
        try {
            movimentos = JSON.parse(localStorage.getItem('historico_movimentos') || '[]') || [];
        } catch (e) {
            movimentos = [];
        }
        movimentos.push(movimento);
        this._scheduleSave('historico_movimentos', () => localStorage.setItem('historico_movimentos', JSON.stringify(movimentos)), 150);
        // Sync remoto (+ ajuste de estoque no backend)
        this._syncAdd('movimentos', movimento);
        try {
            const delta = (movimento.tipo === 'saida' ? -Math.abs(movimento.quantidade || 0) : Math.abs(movimento.quantidade || 0));
            if (delta && movimento.produtoId != null) {
                this._syncAdjustStock(String(movimento.produtoId), delta);
            }
        } catch (_) {}
        // Dispara evento e atualiza seção de "Movimentações Recentes" automaticamente
        try { document.dispatchEvent(new CustomEvent('movimentos_atualizados', { detail: movimento })); } catch (_) {}
        if (typeof this.renderizarMovimentacoesRecentes === 'function') {
            this.renderizarMovimentacoesRecentes();
        }
    }

    obterMovimentosEstoque() {
        try {
            return JSON.parse(localStorage.getItem('historico_movimentos') || '[]') || [];
        } catch (e) {
            return [];
        }
    }

    obterVendas(dataInicio = null, dataFim = null) {
        let vendas = JSON.parse(localStorage.getItem('historico_vendas') || '[]');
        
        if (dataInicio && dataFim) {
            // Garantir parse correto em ambiente pt-BR e horário local
            const parseLocalDate = (str) => {
                // Espera 'YYYY-MM-DD'
                const [y, m, d] = str.split('-').map(Number);
                const dt = new Date(y, (m - 1), d, 0, 0, 0, 0);
                return dt;
            };
            const inicio = parseLocalDate(dataInicio);
            const fim = parseLocalDate(dataFim);
            fim.setHours(23, 59, 59, 999); // Incluir o dia inteiro
            
            vendas = vendas.filter(venda => {
                const dataVenda = new Date(venda.data);
                return dataVenda >= inicio && dataVenda <= fim;
            });
        }
        
        return vendas;
    }

    // Helper para verificar correspondência de vendedor por ID, com fallback por nome
    correspondeVendedor(vendaVendedor, vendedorFiltroId) {
        if (!vendaVendedor || !vendedorFiltroId) return false;
        // Correspondência direta por ID
        if (String(vendaVendedor.id) === String(vendedorFiltroId)) return true;

        // Fallback: comparar por nome quando o ID do registro antigo não confere
        const normalizar = (t) => (t || '').toString().toLowerCase().trim();
        const selecionado = this.vendedores.find(v => String(v.id) === String(vendedorFiltroId));
        if (selecionado && vendaVendedor.nome) {
            return normalizar(vendaVendedor.nome) === normalizar(selecionado.nome);
        }

        // Último fallback: tentar obter nome do option selecionado (se existir na UI)
        try {
            const sel = document.getElementById('vendedor-relatorio-select');
            const label = sel?.selectedOptions?.[0]?.textContent || '';
            const nomeOption = label.split(' — ')[0];
            if (nomeOption) {
                return normalizar(vendaVendedor.nome) === normalizar(nomeOption);
            }
        } catch (e) { /* noop */ }
        return false;
    }

    calcularResumoFinanceiro(vendas) {
        const totalVendas = vendas.reduce((total, venda) => total + (venda.totalVenda || 0), 0);
        const totalCustos = vendas.reduce((total, venda) => total + (venda.totalCusto || 0), 0);
        const totalLucro = totalVendas - totalCustos;
        
        return {
            vendas: totalVendas,
            custos: totalCustos,
            lucro: totalLucro
        };
    }

    atualizarRelatorios() {
        // Limites locais do dia atual para evitar problemas de fuso horário
        const inicioHoje = new Date();
        inicioHoje.setHours(0, 0, 0, 0);
        const fimHoje = new Date();
        fimHoje.setHours(23, 59, 59, 999);
        let vendasHoje = this.obterVendas().filter(venda => {
            const dataVenda = new Date(venda.data);
            return dataVenda >= inicioHoje && dataVenda <= fimHoje;
        });
        // Aplicar filtro por vendedor se houver seleção na aba Relatórios
        const vendedorFiltroEl = document.getElementById('vendedor-relatorio-select');
        if (vendedorFiltroEl && vendedorFiltroEl.value) {
            const vendedorFiltro = vendedorFiltroEl.value;
            vendasHoje = vendasHoje.filter(v => this.correspondeVendedor(v.vendedor, vendedorFiltro));
        }
        
        const resumo = this.calcularResumoFinanceiro(vendasHoje);
        
        document.getElementById('vendas-hoje-valor').textContent = `R$ ${resumo.vendas.toFixed(2).replace('.', ',')}`;
        document.getElementById('gastos-hoje').textContent = `R$ ${resumo.custos.toFixed(2).replace('.', ',')}`;
        document.getElementById('lucro-hoje').textContent = `R$ ${resumo.lucro.toFixed(2).replace('.', ',')}`;

        // Atualizar margem média
        const margemMediaEl = document.getElementById('margem-media');
        if (margemMediaEl) {
            const margemMedia = resumo.vendas > 0 ? ((resumo.lucro / resumo.vendas) * 100) : 0;
            margemMediaEl.textContent = `${margemMedia.toFixed(1)}%`;
        }
        
        this.atualizarHistoricoVendas(vendasHoje);

        // Atualizar seções novas do relatório para o período atual (hoje)
        this.atualizarResumoPeriodo(vendasHoje);
        this.atualizarTopProdutosPeriodo(vendasHoje);
        this.atualizarVendasPorDiaPeriodo(vendasHoje);
        // Atualizar nova sub-aba analítica
        if (this && typeof this.atualizarAnaliseDetalhadaPeriodo === 'function') {
            this.atualizarAnaliseDetalhadaPeriodo(vendasHoje);
        }
    }

    atualizarHistoricoVendas(vendas) {
        const lista = document.getElementById('historico-lista');
        
        if (vendas.length === 0) {
            lista.innerHTML = '<p style="text-align: center; color: #718096;">Nenhuma venda registrada</p>';
            return;
        }
        
        let html = '';
        vendas.slice().reverse().forEach((venda, index) => {
            const data = new Date(venda.data);
            const dataFormatada = data.toLocaleString('pt-BR');
            const itensTexto = venda.itens.map(item => `${item.quantidade}x ${item.nome}`).join(', ');
            
            html += `
                <div class="historico-item">
                    <div class="historico-info">
                        <div class="historico-data">${dataFormatada}</div>
                        <div class="historico-detalhes">${itensTexto}</div>
                        <div class="historico-detalhes">Pagamento: ${this.formatarFormaPagamento(venda.formaPagamento)}</div>
                        ${venda.vendedor ? `<div class="historico-detalhes">Vendedor: ${venda.vendedor.nome}</div>` : ''}
                    </div>
                    <div class="historico-valores">
                        <div class="historico-venda">R$ ${venda.totalVenda.toFixed(2).replace('.', ',')}</div>
                        <div class="historico-lucro">Lucro: R$ ${venda.lucro.toFixed(2).replace('.', ',')}</div>
                    </div>
                </div>
            `;
        });
        
        lista.innerHTML = html;
    }

    formatarFormaPagamento(forma) {
        const formas = {
            'dinheiro': 'Dinheiro',
            'credito': 'Cartão de Crédito',
            'debito': 'Cartão de Débito',
            'pix': 'PIX'
        };
        return formas[forma] || forma;
    }

    atualizarResumoPeriodo(vendas) {
        const totalVendas = vendas.reduce((t, v) => t + (v.totalVenda || 0), 0);
        const quantidade = vendas.length;
        const ticketMedio = quantidade > 0 ? totalVendas / quantidade : 0;
        const lucroTotal = vendas.reduce((t, v) => t + (v.lucro || 0), 0);

        const setText = (id, texto) => {
            const el = document.getElementById(id);
            if (el) el.textContent = texto;
        };

        setText('periodo-total-vendas', `R$ ${totalVendas.toFixed(2).replace('.', ',')}`);
        setText('periodo-quantidade-vendas', `${quantidade}`);
        setText('periodo-ticket-medio', `R$ ${ticketMedio.toFixed(2).replace('.', ',')}`);
        setText('periodo-lucro-total', `R$ ${lucroTotal.toFixed(2).replace('.', ',')}`);

        const formas = { dinheiro: { count: 0, total: 0 }, credito: { count: 0, total: 0 }, debito: { count: 0, total: 0 }, pix: { count: 0, total: 0 } };
        vendas.forEach(v => { if (formas[v.formaPagamento]) { formas[v.formaPagamento].count++; formas[v.formaPagamento].total += (v.totalVenda || 0); } });
        setText('pagamento-dinheiro', `${formas.dinheiro.count} vendas • R$ ${formas.dinheiro.total.toFixed(2).replace('.', ',')}`);
        setText('pagamento-credito', `${formas.credito.count} vendas • R$ ${formas.credito.total.toFixed(2).replace('.', ',')}`);
        setText('pagamento-debito', `${formas.debito.count} vendas • R$ ${formas.debito.total.toFixed(2).replace('.', ',')}`);
        setText('pagamento-pix', `${formas.pix.count} vendas • R$ ${formas.pix.total.toFixed(2).replace('.', ',')}`);
    }

    atualizarTopProdutosPeriodo(vendas) {
        const acumulado = {};
        vendas.forEach(v => (v.itens || []).forEach(item => {
            if (!acumulado[item.nome]) acumulado[item.nome] = { nome: item.nome, quantidade: 0, receita: 0 };
            acumulado[item.nome].quantidade += item.quantidade || 0;
            const unit = (item.precoUnitario != null ? item.precoUnitario : item.preco) || 0;
            acumulado[item.nome].receita += unit * (item.quantidade || 0);
        }));
        const lista = document.getElementById('lista-top-produtos');
        if (!lista) return;
        const top = Object.values(acumulado).sort((a, b) => b.quantidade - a.quantidade).slice(0, 5);
        if (top.length === 0) { lista.innerHTML = '<p style="text-align: center; color: #718096;">Sem vendas no período</p>'; return; }
        let html = '';
        top.forEach(p => { html += `
            <div class="venda-item-resumo">
                <div class="item-info">
                    <div class="item-nome">${p.nome}</div>
                    <div class="item-detalhes">Quantidade: ${p.quantidade}</div>
                </div>
                <div class="item-subtotal">R$ ${p.receita.toFixed(2).replace('.', ',')}</div>
            </div>
        `; });
        lista.innerHTML = html;
    }

    atualizarVendasPorDiaPeriodo(vendas) {
        const porDia = {};
        vendas.forEach(v => {
            const dt = new Date(v.data);
            const chave = dt.toLocaleDateString('pt-BR');
            if (!porDia[chave]) porDia[chave] = { data: chave, quantidade: 0, vendas: 0, lucro: 0 };
            porDia[chave].quantidade += 1;
            porDia[chave].vendas += (v.totalVenda || 0);
            porDia[chave].lucro += (v.lucro || 0);
        });
        const lista = document.getElementById('lista-vendas-periodo');
        if (!lista) return;
        const dias = Object.values(porDia).sort((a, b) => {
            const [da, ma, ya] = a.data.split('/');
            const [db, mb, yb] = b.data.split('/');
            return new Date(`${ya}-${ma}-${da}`) - new Date(`${yb}-${mb}-${db}`);
        });
        if (dias.length === 0) { 
            lista.innerHTML = '<p style="text-align: center; color: #718096;">Sem vendas no período</p>'; 
            if (this && typeof this.renderizarGraficoVendasPorDia === 'function') {
                this.renderizarGraficoVendasPorDia([]);
            }
            return; 
        }
        let html = '';
        dias.forEach(d => { html += `
            <div class="venda-item-resumo">
                <div class="item-info">
                    <div class="item-nome">${d.data}</div>
                    <div class="item-detalhes">${d.quantidade} vendas</div>
                </div>
                <div class="item-subtotal">R$ ${d.vendas.toFixed(2).replace('.', ',')} • Lucro R$ ${d.lucro.toFixed(2).replace('.', ',')}</div>
            </div>
        `; });
        lista.innerHTML = html;
        if (this && typeof this.renderizarGraficoVendasPorDia === 'function') {
            this.renderizarGraficoVendasPorDia(dias);
        }
    }

    // ===== Entrada Rápida de Estoque =====
    toggleEntradaRapida(force) {
        const bloco = document.getElementById('entrada-rapida');
        if (!bloco) return;
        const show = typeof force === 'boolean' ? force : (bloco.style.display === 'none' || bloco.style.display === '');
        bloco.style.display = show ? 'block' : 'none';
        if (show) {
            this._popularEntradaRapidaSelect();
            const qtd = document.getElementById('entrada-quantidade');
            if (qtd) qtd.value = '';
            const obs = document.getElementById('entrada-observacao');
            if (obs) obs.value = '';
        }
    }

    focarEntradaRapida() {
        const bloco = document.getElementById('entrada-rapida');
        if (!bloco) return;
        this._popularEntradaRapidaSelect();
        bloco.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const select = document.getElementById('entrada-produto');
        if (select) select.focus();
    }

    limparEntradaRapida() {
        const select = document.getElementById('entrada-produto');
        if (select) select.value = '';
        const qtd = document.getElementById('entrada-quantidade');
        if (qtd) qtd.value = '';
        const obs = document.getElementById('entrada-observacao');
        if (obs) obs.value = '';
    }

    setTipoMovRapido(tipo) {
        const bloco = document.getElementById('entrada-rapida');
        if (!bloco) return;
        const t = tipo === 'saida' ? 'saida' : 'entrada';
        this._tipoMovRapido = t;
        bloco.setAttribute('data-tipo', t);
        const titulo = document.getElementById('mov-titulo');
        const icon = document.getElementById('mov-icon');
        const btnText = document.getElementById('mov-btn-text');
        if (titulo) titulo.textContent = t === 'entrada' ? 'Registrar Entrada' : 'Registrar Saída';
        if (icon) icon.textContent = t === 'entrada' ? '⬆️' : '⬇️';
        if (btnText) btnText.textContent = t === 'entrada' ? 'Confirmar Entrada' : 'Confirmar Saída';
        // Atualiza estado visual do toggle
        const toggle = bloco.querySelector('.tipo-toggle');
        if (toggle) {
            const btns = toggle.querySelectorAll('.tipo-btn');
            btns.forEach(b => b.classList.remove('active'));
            const target = t === 'entrada' ? btns[0] : btns[1];
            if (target) target.classList.add('active');
        }
        // Atualiza validação de acordo com o tipo
        this.atualizarValidacaoMovRapido();
    }

    _popularEntradaRapidaSelect() {
        const select = document.getElementById('entrada-produto');
        if (!select) return;
        // Preencher com produtos
        select.innerHTML = '<option value="">Selecione o produto...</option>';
        (this.produtos || []).forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.nome} — estoque: ${p.estoque ?? 0}`;
            select.appendChild(opt);
        });
    }

    inicializarEntradaRapidaInteracoes() {
        const select = document.getElementById('entrada-produto');
        const qtd = document.getElementById('entrada-quantidade');
        if (select) select.addEventListener('change', () => this.atualizarValidacaoMovRapido());
        if (qtd) qtd.addEventListener('input', () => this.atualizarValidacaoMovRapido());
        this.atualizarValidacaoMovRapido();
    }

    alterarQuantidade(delta) {
        const qtd = document.getElementById('entrada-quantidade');
        if (!qtd) return;
        const atual = parseInt(qtd.value || '0') || 0;
        let novo = atual + delta;
        if (!Number.isFinite(novo) || novo < 1) novo = 1;
        const tipo = this._tipoMovRapido || 'entrada';
        if (tipo === 'saida') {
            const select = document.getElementById('entrada-produto');
            const id = parseInt(select?.value || '0') || 0;
            const prod = this.getProdutoById(id);
            const max = prod ? (parseInt(prod.estoque) || 0) : Infinity;
            if (Number.isFinite(max)) novo = Math.min(novo, Math.max(1, max));
        }
        qtd.value = String(novo);
        this.atualizarValidacaoMovRapido();
    }

    atualizarValidacaoMovRapido() {
        const select = document.getElementById('entrada-produto');
        const qtd = document.getElementById('entrada-quantidade');
        const badge = document.getElementById('stock-hint');
        const feedback = document.getElementById('qtd-feedback');
        const btnConfirm = document.getElementById('mov-btn-confirm');
        const tipo = this._tipoMovRapido || 'entrada';
        const id = parseInt(select?.value || '0') || 0;
        const prod = this.getProdutoById(id);
        const estoque = prod ? (parseInt(prod.estoque) || 0) : 0;
        const quantidade = parseInt(qtd?.value || '0') || 0;

        if (badge) { badge.textContent = prod ? `Estoque atual: ${estoque}` : ''; }

        let valido = true;
        if (!id || !Number.isFinite(quantidade) || quantidade < 1) valido = false;
        if (tipo === 'saida' && quantidade > estoque) {
            valido = false;
            if (feedback) feedback.textContent = `Quantidade excede o estoque disponível (${estoque}).`;
        } else {
            if (feedback) feedback.textContent = '';
        }
        if (btnConfirm) btnConfirm.disabled = !valido;
    }

    mostrarAjudaAtalhos() {
        const msg = `Atalhos disponíveis:\n\n• I: alterna para Entrada\n• S: alterna para Saída\n• E: cadastro rápido de Produto\n• Ctrl+Enter: confirmar\n• Ctrl+K: abrir paleta de comandos`;
        this.mostrarModal('Atalhos', msg, 'info');
    }

    abrirCommandPalette() {
        const overlay = document.getElementById('cmdk-overlay');
        const input = document.getElementById('cmdk-input');
        const list = document.getElementById('cmdk-list');
        if (!overlay || !input || !list) return;
        overlay.style.display = 'block';
        this._cmdkSelIdx = 0;
        this._cmds = [
            { id: 'go-caixa', label: 'Ir para Caixa' },
            { id: 'go-estoque', label: 'Ir para Estoque' },
            { id: 'go-produtos', label: 'Ir para Produtos' },
            { id: 'go-relatorios', label: 'Ir para Relatórios' },
            { id: 'entrada', label: 'Registrar Entrada' },
            { id: 'saida', label: 'Registrar Saída' },
            { id: 'buscar-estoque', label: 'Buscar produto no Estoque' },
            { id: 'cadastrar', label: 'Cadastrar novo produto' }
        ];
        input.value = '';
        this._renderCmdk('');
        input.focus();
        input.onkeydown = (e) => {
            const items = Array.from(list.querySelectorAll('.cmdk-item'));
            if (e.key === 'ArrowDown') { e.preventDefault(); this._cmdkSelIdx = Math.min(this._cmdkSelIdx + 1, Math.max(items.length - 1, 0)); this._highlightCmdk(items); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); this._cmdkSelIdx = Math.max(this._cmdkSelIdx - 1, 0); this._highlightCmdk(items); }
            else if (e.key === 'Enter') { e.preventDefault(); const target = items[this._cmdkSelIdx]; if (target) this.executarComando(target.getAttribute('data-id')); }
            else if (e.key === 'Escape') { e.preventDefault(); this.fecharCommandPalette(); }
        };
        input.oninput = (e) => { this._renderCmdk(e.target.value || ''); };
        list.onclick = (ev) => { const item = ev.target.closest('.cmdk-item'); if (item) this.executarComando(item.getAttribute('data-id')); };
    }

    _renderCmdk(query) {
        const list = document.getElementById('cmdk-list');
        if (!list) return;
        const q = (query || '').toLowerCase();
        const items = (this._cmds || []).filter(c => c.label.toLowerCase().includes(q));
        list.innerHTML = items.map((c, i) => `<li class="cmdk-item${i===0?' active':''}" data-id="${c.id}" role="option">${c.label}</li>`).join('');
        this._cmdkSelIdx = 0;
    }

    _highlightCmdk(items) {
        items.forEach((el, i) => { if (i === this._cmdkSelIdx) el.classList.add('active'); else el.classList.remove('active'); });
    }

    fecharCommandPalette() {
        const overlay = document.getElementById('cmdk-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    executarComando(cmdId) {
        switch (cmdId) {
            case 'go-caixa': showTab('caixa'); break;
            case 'go-estoque': showTab('estoque'); break;
            case 'go-produtos': showTab('produtos'); break;
            case 'go-relatorios': showTab('relatorios'); break;
            case 'entrada': showTab('estoque'); this.setTipoMovRapido('entrada'); this.focarEntradaRapida(); break;
            case 'saida': showTab('estoque'); this.setTipoMovRapido('saida'); this.focarEntradaRapida(); break;
            case 'buscar-estoque': showTab('estoque'); const b = document.getElementById('buscar-produto'); if (b) b.focus(); break;
            case 'cadastrar': showTab('produtos'); const n = document.getElementById('produto-nome'); if (n) n.scrollIntoView({behavior:'smooth',block:'center'}); if (n) n.focus(); break;
            default: break;
        }
        this.fecharCommandPalette();
    }

    confirmarEntradaRapida() {
        const select = document.getElementById('entrada-produto');
        const qtdInput = document.getElementById('entrada-quantidade');
        const obsInput = document.getElementById('entrada-observacao');
        if (!select || !qtdInput) return;
        const id = parseInt(select.value);
        const quantidade = parseInt(qtdInput.value);
        const observacao = obsInput ? obsInput.value.trim() : '';

        if (!id) { this.mostrarToast('Selecione um produto.', 'error'); return; }
        if (!Number.isFinite(quantidade) || quantidade <= 0) { this.mostrarToast('Informe uma quantidade válida.', 'error'); return; }

        const produto = this.getProdutoById(id);
        if (!produto) { this.mostrarToast('Produto não encontrado.', 'error'); return; }

        const estoqueAntes = produto.estoque || 0;
        let estoqueDepois;
        if ((this._tipoMovRapido || 'entrada') === 'saida') {
            if (estoqueAntes < quantidade) {
                this.mostrarToast('Estoque insuficiente para saída.', 'error');
                return;
            }
            estoqueDepois = estoqueAntes - quantidade;
        } else {
            estoqueDepois = estoqueAntes + quantidade;
        }
        produto.estoque = estoqueDepois;
        this.salvarProdutos();
        this.atualizarEstoque();
        this.atualizarListaProdutos();

        // Registrar movimento
        const movimento = {
            tipo: (this._tipoMovRapido || 'entrada'),
            produtoId: produto.id,
            produtoNome: produto.nome,
            quantidade,
            antes: estoqueAntes,
            depois: estoqueDepois,
            origem: 'entrada-rapida',
            observacao,
            data: new Date().toISOString()
        };
        if (typeof this.registrarMovimentoEstoque === 'function') {
            this.registrarMovimentoEstoque(movimento);
        }
        if (typeof this.renderizarMovimentacoesRecentes === 'function') {
            this.renderizarMovimentacoesRecentes();
        }

        this.mostrarToast(((this._tipoMovRapido || 'entrada') === 'entrada' ? 'Entrada' : 'Saída') + ' registrada com sucesso!', 'success');
        this.limparEntradaRapida();
    }

    // Renderização de gráfico de barras para "Vendas por Dia"
    renderizarGraficoVendasPorDia(dias) {
        const canvas = document.getElementById('grafico-vendas-dia');
        if (!canvas) return;

        // Se já existe um gráfico, destrói para recriar limpo
        if (this._chartVendasDia) {
            this._chartVendasDia.destroy();
            this._chartVendasDia = null;
        }

        // Preparar dados
        const labels = dias.map(d => d.data); // formato dd/mm/aaaa
        const vendas = dias.map(d => Number(d.vendas || 0));
        const lucro = dias.map(d => Number(d.lucro || 0));

        const ctx = canvas.getContext('2d');

        const data = {
            labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Vendas (R$)',
                    data: vendas,
                    backgroundColor: 'rgba(37, 99, 235, 0.6)',
                    borderColor: 'rgba(37, 99, 235, 1)',
                    borderWidth: 1,
                    borderRadius: 6,
                },
                {
                    type: 'line',
                    label: 'Lucro (R$)',
                    data: lucro,
                    borderColor: 'rgba(16, 185, 129, 1)',
                    backgroundColor: 'rgba(16, 185, 129, 0.15)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 3,
                    pointBackgroundColor: 'rgba(16, 185, 129, 1)',
                }
            ]
        };

        const options = {
            responsive: true,
            maintainAspectRatio: false, // usa a altura do container
            plugins: {
                legend: { position: 'top' },
                title: { display: true, text: 'Vendas por Dia' },
                tooltip: {
                    callbacks: {
                        label: (context) => {
                            const valor = context.parsed.y ?? context.raw ?? 0;
                            const label = context.dataset.label || '';
                            return `${label}: R$ ${Number(valor).toFixed(2).replace('.', ',')}`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { maxRotation: 45, minRotation: 0 },
                },
                y: {
                    beginAtZero: true,
                    grid: { color: '#E2E8F0' },
                    ticks: {
                        // mostra valores como R$
                        callback: (value) => `R$ ${Number(value).toFixed(0)}`,
                    }
                }
            }
        };

        this._chartVendasDia = new Chart(ctx, { data, options });
    }

    // ====== Nova: Atualização da sub-aba Analítica ======
    atualizarAnaliseDetalhadaPeriodo(vendas) {
        try {
            // Desempenho por Vendedor
            const vendedoresAgg = {};
            vendas.forEach(v => {
                const nome = (v.vendedor && v.vendedor.nome) ? v.vendedor.nome : '— Sem vendedor';
                if (!vendedoresAgg[nome]) {
                    vendedoresAgg[nome] = { nome, vendas: 0, lucro: 0, quantidade: 0 };
                }
                vendedoresAgg[nome].vendas += Number(v.totalVenda || 0);
                vendedoresAgg[nome].lucro += Number(v.lucro || 0);
                vendedoresAgg[nome].quantidade += 1;
            });
            const listaVend = document.getElementById('lista-vendedores-analise');
            if (listaVend) {
                const arr = Object.values(vendedoresAgg).sort((a, b) => b.vendas - a.vendas);
                if (arr.length === 0) {
                    listaVend.innerHTML = '<p style="text-align: center; color: #718096;">Sem vendas no período</p>';
                } else {
                    let html = '';
                    arr.forEach(vd => {
                        const ticket = vd.quantidade > 0 ? (vd.vendas / vd.quantidade) : 0;
                        html += `
                            <div class="venda-item-resumo">
                                <div class="item-info">
                                    <div class="item-nome">${vd.nome}</div>
                                    <div class="item-detalhes">${vd.quantidade} vendas • Ticket médio R$ ${ticket.toFixed(2).replace('.', ',')}</div>
                                </div>
                                <div class="item-subtotal">R$ ${vd.vendas.toFixed(2).replace('.', ',')} • Lucro R$ ${vd.lucro.toFixed(2).replace('.', ',')}</div>
                            </div>
                        `;
                    });
                    listaVend.innerHTML = html;
                }
            }

            // Distribuição por Categoria
            const categoriasAgg = {};
            const getCategoria = (id) => {
                const prod = this.produtos.find(p => String(p.id) === String(id));
                return (prod && prod.categoria) ? prod.categoria : 'Outros';
            };
            vendas.forEach(v => (v.itens || []).forEach(item => {
                const cat = getCategoria(item.id);
                if (!categoriasAgg[cat]) categoriasAgg[cat] = { categoria: cat, quantidade: 0, receita: 0 };
                const unit = (item.precoUnitario != null ? item.precoUnitario : item.preco) || 0;
                categoriasAgg[cat].quantidade += (item.quantidade || 0);
                categoriasAgg[cat].receita += unit * (item.quantidade || 0);
            }));
            const listaCat = document.getElementById('lista-categorias-analise');
            const categoriasArr = Object.values(categoriasAgg).sort((a, b) => b.receita - a.receita);
            if (listaCat) {
                if (categoriasArr.length === 0) {
                    listaCat.innerHTML = '<p style="text-align: center; color: #718096;">Sem vendas no período</p>';
                } else {
                    let html = '';
                    categoriasArr.forEach(c => {
                        html += `
                            <div class="venda-item-resumo">
                                <div class="item-info">
                                    <div class="item-nome">${c.categoria}</div>
                                    <div class="item-detalhes">${c.quantidade} itens vendidos</div>
                                </div>
                                <div class="item-subtotal">R$ ${c.receita.toFixed(2).replace('.', ',')}</div>
                            </div>
                        `;
                    });
                    listaCat.innerHTML = html;
                }
            }

            // Gráfico de Categorias (receita)
            this.renderizarGraficoCategorias(categoriasArr);

            // Horários de Pico (quantidade de vendas por hora)
            const horasAgg = Array.from({ length: 24 }, (_, h) => ({ hora: h, quantidade: 0 }));
            vendas.forEach(v => {
                const d = new Date(v.data);
                const h = d.getHours();
                if (horasAgg[h]) horasAgg[h].quantidade += 1;
            });
            this.renderizarGraficoHorarios(horasAgg);

            // Formas de Pagamento (totais do período)
            const formas = { dinheiro: { count: 0, total: 0 }, credito: { count: 0, total: 0 }, debito: { count: 0, total: 0 }, pix: { count: 0, total: 0 } };
            vendas.forEach(v => {
                const fp = (v.formaPagamento || '').toLowerCase();
                if (formas[fp]) {
                    formas[fp].count += 1;
                    formas[fp].total += Number(v.totalVenda || 0);
                }
            });
            this.renderizarGraficoPagamentos(formas);
        } catch (e) {
            console.error('Erro ao atualizar análise detalhada:', e);
        }
    }

    renderizarGraficoCategorias(categoriasArr) {
        const canvas = document.getElementById('grafico-categorias');
        if (!canvas) return;
        if (this._chartCategorias) { this._chartCategorias.destroy(); this._chartCategorias = null; }
        const labels = categoriasArr.map(c => c.categoria);
        const dados = categoriasArr.map(c => Number(c.receita || 0));
        const ctx = canvas.getContext('2d');
        const data = { labels, datasets: [{ type: 'bar', label: 'Receita (R$)', data: dados, backgroundColor: 'rgba(99, 102, 241, 0.6)', borderColor: 'rgba(99, 102, 241, 1)', borderWidth: 1, borderRadius: 6 }] };
        const options = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' }, title: { display: true, text: 'Receita por Categoria' }, tooltip: { callbacks: { label: (ctx) => { const v = ctx.parsed.y ?? ctx.raw ?? 0; return `R$ ${Number(v).toFixed(2).replace('.', ',')}`; } } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: '#E2E8F0' }, ticks: { callback: (v) => `R$ ${Number(v).toFixed(0)}` } } } };
        this._chartCategorias = new Chart(ctx, { data, options });
    }

    renderizarGraficoHorarios(horasAgg) {
        const canvas = document.getElementById('grafico-horarios');
        if (!canvas) return;
        if (this._chartHorarios) { this._chartHorarios.destroy(); this._chartHorarios = null; }
        const labels = horasAgg.map(h => String(h.hora).padStart(2, '0'));
        const dados = horasAgg.map(h => Number(h.quantidade || 0));
        const ctx = canvas.getContext('2d');
        const data = { labels, datasets: [{ type: 'line', label: 'Vendas (quantidade)', data: dados, borderColor: 'rgba(34, 197, 94, 1)', backgroundColor: 'rgba(34, 197, 94, 0.2)', tension: 0.3, fill: true, pointRadius: 2, pointBackgroundColor: 'rgba(34, 197, 94, 1)' }] };
        const options = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top' }, title: { display: true, text: 'Horários de Pico' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: '#E2E8F0' }, ticks: { stepSize: 1 } } } };
        this._chartHorarios = new Chart(ctx, { data, options });
    }

    renderizarGraficoPagamentos(formas) {
        const canvas = document.getElementById('grafico-pagamentos');
        if (!canvas) return;
        if (this._chartPagamentos) { this._chartPagamentos.destroy(); this._chartPagamentos = null; }
        const labels = ['Dinheiro', 'Crédito', 'Débito', 'Pix'];
        const dados = [formas.dinheiro.total, formas.credito.total, formas.debito.total, formas.pix.total].map(v => Number(v || 0));
        const ctx = canvas.getContext('2d');
        const data = { labels, datasets: [{ type: 'doughnut', label: 'Total por Forma (R$)', data: dados, backgroundColor: ['#f59e0b','#3b82f6','#10b981','#8b5cf6'], borderColor: '#fff', borderWidth: 2 }] };
        const options = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' }, title: { display: true, text: 'Formas de Pagamento' }, tooltip: { callbacks: { label: (ctx) => { const v = ctx.parsed ?? 0; const l = labels[ctx.dataIndex]; return `${l}: R$ ${Number(v).toFixed(2).replace('.', ',')}`; } } } } };
        this._chartPagamentos = new Chart(ctx, { data, options });
    }

    inicializarDatasRelatorio() {
        const hoje = new Date();
        const dataHoje = hoje.toISOString().split('T')[0];
        
        document.getElementById('data-inicio').value = dataHoje;
        document.getElementById('data-fim').value = dataHoje;
    }

    adicionarProduto(event) {
        if (event) {
            event.preventDefault();
        }
        
        // Limpar mensagens de erro anteriores
        this.limparErros();
        
        const nome = document.getElementById('produto-nome').value.trim();
        const categoria = document.getElementById('produto-categoria').value;
        const custo = parseFloat(document.getElementById('produto-custo').value) || 0;
        const preco = parseFloat(document.getElementById('produto-preco').value) || 0;
        const quantidade = parseInt(document.getElementById('produto-estoque').value) || 0;
        const codigo = (document.getElementById('produto-codigo')?.value || '').trim();
        const fornecedor = (document.getElementById('produto-fornecedor')?.value || '').trim();
        const minimo = parseInt(document.getElementById('produto-minimo')?.value) || 0;
        const descricao = (document.getElementById('produto-descricao')?.value || '').trim();
        
        let temErro = false;
        
        // Validações com mensagens específicas
        if (!nome) {
            this.validarCampo(document.getElementById('produto-nome'), 'Nome é obrigatório');
            temErro = true;
        } else if (nome.length < 2) {
            this.validarCampo(document.getElementById('produto-nome'), 'Nome deve ter pelo menos 2 caracteres');
            temErro = true;
        } else {
            this.validarCampo(document.getElementById('produto-nome'));
        }
        
        if (!categoria) {
            this.validarCampo(document.getElementById('produto-categoria'), 'Categoria é obrigatória');
            temErro = true;
        } else {
            this.validarCampo(document.getElementById('produto-categoria'));
        }
        
        // Validações opcionais dos novos campos
        if (codigo && codigo.length < 8) {
            this.validarCampo(document.getElementById('produto-codigo'), 'Código deve ter pelo menos 8 dígitos');
            temErro = true;
        } else if (document.getElementById('produto-codigo')) {
            this.validarCampo(document.getElementById('produto-codigo'));
        }
        if (minimo < 0) {
            this.validarCampo(document.getElementById('produto-minimo'), 'Estoque mínimo não pode ser negativo');
            temErro = true;
        } else if (document.getElementById('produto-minimo')) {
            this.validarCampo(document.getElementById('produto-minimo'));
        }
        
        if (custo <= 0) {
            this.validarCampo(document.getElementById('produto-custo'), 'Custo deve ser maior que zero');
            temErro = true;
        } else {
            this.validarCampo(document.getElementById('produto-custo'));
        }
        
        if (preco <= 0) {
            this.validarCampo(document.getElementById('produto-preco'), 'Preço deve ser maior que zero');
            temErro = true;
        } else if (preco <= custo) {
            this.validarCampo(document.getElementById('produto-preco'), 'Preço deve ser maior que o custo');
            temErro = true;
        } else {
            this.validarCampo(document.getElementById('produto-preco'));
        }
        
        // Verificar se estamos editando um produto
        if (this.produtoEditando) {
            // Modo edição
            const produto = this.getProdutoById(this.produtoEditando);
            if (produto) {
                // Verificar se o nome não conflita com outro produto
                const produtoExistente = this.produtos.find(p => 
                    p.nome.toLowerCase() === nome.toLowerCase() && p.id !== this.produtoEditando
                );
                if (produtoExistente) {
                    this.validarCampo(document.getElementById('produto-nome'), 'Já existe outro produto com este nome!');
                    temErro = true;
                }
                
                if (temErro) {
                    return;
                }
                
                // Atualizar produto existente
                produto.nome = nome;
                produto.categoria = categoria;
                produto.preco = preco;
                produto.custo = custo;
                produto.estoque = quantidade;
                produto.codigo = codigo;
                produto.fornecedor = fornecedor;
                produto.minimo = minimo;
                produto.descricao = descricao;
                 
                 this.salvarDados();
                 this.atualizarListaProdutos();
                 this.atualizarEstoque();
                 this.atualizarEstatisticasProdutos();
                 
                 // Resetar modo de edição
                 this.produtoEditando = null;
                 const botaoAdicionar = document.querySelector('.btn-primary');
                 const botaoCancelar = document.querySelector('.btn-cancelar');
                 
                 if (botaoAdicionar) {
                     botaoAdicionar.textContent = '✅ Adicionar Produto';
                 }
                 if (botaoCancelar) {
                     botaoCancelar.style.display = 'none';
                 }
                 
                 this.mostrarModal('Sucesso', `Produto "${nome}" atualizado com sucesso!`, 'success');
            }
        } else {
            // Modo adição
            // Verificar se produto já existe
            if (this.produtos.some(p => p.nome.toLowerCase() === nome.toLowerCase())) {
                this.validarCampo(document.getElementById('produto-nome'), 'Produto já existe no sistema');
                temErro = true;
            }
            
            if (temErro) {
                return;
            }
            
            const novoId = Math.max(...this.produtos.map(p => p.id), 0) + 1;
            
            this.produtos.push({
                id: novoId,
                nome,
                categoria,
                preco,
                custo,
                estoque: quantidade,
                codigo,
                fornecedor,
                minimo,
                descricao
            });
             
             this.salvarDados();
             this.atualizarListaProdutos();
             this.atualizarEstoque();
             this.atualizarEstatisticasProdutos();
             this.mostrarModal('Sucesso', `Produto "${nome}" adicionado com sucesso!`, 'success');
        }
        
        // Limpar formulário
        this.limparFormulario();
        
        // Atualizar interface
        this.carregarProdutosSelect();
        this.atualizarEstoque();
        this.atualizarListaProdutos();
        this.atualizarEstatisticasProdutos();
    }
    
    mostrarErro(elementId, mensagem) {
        const elemento = document.getElementById(elementId);
        if (elemento) {
            elemento.textContent = mensagem;
            elemento.style.display = 'block';
        }
    }
    
    limparErros() {
        const erros = document.querySelectorAll('.error-message');
        erros.forEach(erro => {
            erro.textContent = '';
            erro.style.display = 'none';
        });
    }
    
    limparFormulario() {
        const form = document.getElementById('produto-form');
        if (!form) return;
        
        form.reset();
        document.getElementById('produto-estoque').value = '0';
        if (document.getElementById('produto-minimo')) {
            document.getElementById('produto-minimo').value = '0';
        }
        document.getElementById('margem-lucro').textContent = '0%';
        
        // Limpar mensagens de validação
        const validationMessages = form.querySelectorAll('.validation-message');
        validationMessages.forEach(msg => msg.textContent = '');
        
        // Resetar cores dos inputs
        const inputs = form.querySelectorAll('input, select');
        inputs.forEach(input => {
            input.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        });
        
        // Resetar status do formulário
        const formStatus = document.getElementById('form-status');
        if (formStatus) {
            formStatus.textContent = 'Pronto';
            formStatus.className = 'form-status';
        }
        
        // Resetar modo de edição se estiver ativo
        if (this.produtoEditando) {
            this.produtoEditando = null;
            
            const botaoAdicionar = document.querySelector('.btn-primary');
            const botaoCancelar = document.querySelector('.btn-cancelar');
            
            if (botaoAdicionar) {
                botaoAdicionar.textContent = '✅ Adicionar Produto';
            }
            if (botaoCancelar) {
                botaoCancelar.style.display = 'none';
            }
        }
    }
    
    calcularPreviewLucro() {
        const preco = parseFloat(document.getElementById('novo-preco').value) || 0;
        const custo = parseFloat(document.getElementById('novo-custo').value) || 0;
        const previewElement = document.getElementById('preview-lucro');
        
        if (preco > 0 && custo > 0 && custo < preco) {
            const lucro = preco - custo;
            const margemLucro = ((lucro / preco) * 100).toFixed(1);
            previewElement.textContent = `R$ ${lucro.toFixed(2).replace('.', ',')} (${margemLucro}%)`;
            previewElement.style.color = '#38a169';
        } else {
            previewElement.textContent = 'R$ 0,00 (0%)';
            previewElement.style.color = '#718096';
        }
    }

    atualizarEstoque() {
        const lista = document.getElementById('estoque-lista');
        if (!lista) return;
        
        const produtos = this.produtos;
        this._coalesce.renderRaf = this._coalesce.renderRaf || {};
        try { cancelAnimationFrame(this._coalesce.renderRaf['estoque-lista']); } catch (_) {}
        this._coalesce.renderRaf['estoque-lista'] = requestAnimationFrame(() => {
        lista.innerHTML = produtos.map(produto => {
            const categoriaIcon = this.getCategoriaIcon(produto.categoria);
            const minimo = (Number.isFinite(produto.minimo) && produto.minimo > 0) ? produto.minimo : 5;
            const estoqueStatus = produto.estoque === 0 ? 'zero' : produto.estoque <= minimo ? 'baixo' : 'normal';
            const margem = produto.preco > 0 ? ((produto.preco - (produto.custo || 0)) / produto.preco * 100).toFixed(1) : '0.0';
            const disponibilidade = produto.estoque > 0 ? 'Disponível' : 'Indisponível';

            const codigo = produto.codigo || '';
            const descricao = produto.descricao || produto.nome || '';
            const fornecedor = produto.fornecedor || '';
            const localizacao = produto.localizacao || '';

            return `
                <div class="produto-card-novo" 
                    data-categoria="${produto.categoria || ''}" 
                    data-estoque="${estoqueStatus}"
                    data-status="${disponibilidade.toLowerCase()}"
                    data-codigo="${codigo}"
                    data-descricao="${descricao}"
                    data-fornecedor="${fornecedor}"
                    data-localizacao="${localizacao}">

                    <div class="produto-header-novo">
                        <div style="display:flex;align-items:center;gap:.5rem;">
                            <h4 class="produto-nome" style="margin:0;">${produto.nome}</h4>
                            <span class="produto-categoria-tag">${categoriaIcon} ${produto.categoria || 'Sem categoria'}</span>
                        </div>
                        <div class="produto-status">
                            <span class="status-badge ${estoqueStatus === 'zero' ? 'sem-estoque' : estoqueStatus === 'baixo' ? 'estoque-baixo' : 'estoque-ok'}">
                                ${estoqueStatus === 'zero' ? 'SEM ESTOQUE' : estoqueStatus === 'baixo' ? 'ESTOQUE BAIXO' : 'ESTOQUE OK'}
                            </span>
                        </div>
                    </div>

                    <div class="produto-preco-novo">
                        <span class="preco-simbolo">R$</span>
                        <span class="preco-valor">${(produto.preco || 0).toFixed(2).replace('.', ',')}</span>
                    </div>

                    <div class="produto-detalhes-novo">
                        <div class="detalhe-row" style="display:flex;gap:1rem;justify-content:space-between;">
                            <span class="detalhe-label-novo">ESTOQUE</span>
                            <span class="detalhe-label-novo">CUSTO</span>
                            <span class="detalhe-label-novo">MARGEM</span>
                            <span class="detalhe-label-novo">DISPONIBILIDADE</span>
                        </div>
                        <div class="detalhe-valores" style="display:flex;gap:1rem;justify-content:space-between;">
                            <span class="detalhe-valor-novo estoque-valor">${produto.estoque} un</span>
                            <span class="detalhe-valor-novo custo-valor">R$ ${(produto.custo || 0).toFixed(2).replace('.', ',')}</span>
                            <span class="detalhe-valor-novo margem-valor">${margem}%</span>
                            <span class="detalhe-valor-novo disponibilidade-valor">${disponibilidade}</span>
                        </div>

                        <div class="detalhe-row" style="display:flex;gap:1rem;justify-content:space-between;margin-top:.35rem;">
                            <span class="detalhe-label-novo">CÓDIGO</span>
                            <span class="detalhe-label-novo">FORNECEDOR</span>
                        </div>
                        <div class="detalhe-valores" style="display:flex;gap:1rem;justify-content:space-between;">
                            <span class="detalhe-valor-novo">${codigo || '-'}</span>
                            <span class="detalhe-valor-novo">${fornecedor || '-'}</span>
                            <span class="detalhe-valor-novo">${localizacao || '-'}</span>
                        </div>
                    </div>

                    <div class="produto-actions-novo">
                        <button class="btn-editar" onclick="editarProduto(${produto.id})">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            Editar
                        </button>
                        <button class="btn-estoque" onclick="abrirModalEstoque(${produto.id})">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4m-4-4v8m0-8l3 3m-3-3l-3 3"/>
                            </svg>
                            Estoque
                        </button>
                        <button class="btn-excluir" onclick="excluirProduto(${produto.id})">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3,6 5,6 21,6"/>
                                <path d="m19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2"/>
                            </svg>
                            Excluir
                        </button>
                    </div>
                </div>
            `;
        }).join('');
        
        // Atualizar estatísticas do estoque
        this.atualizarEstatisticasEstoque();
        });
    }
    
    atualizarEstatisticasEstoque() {
        const totalItens = this.produtos.reduce((total, produto) => total + (produto.estoque || 0), 0);
        const alertas = this.produtos.filter(produto => {
            const minimo = (Number.isFinite(produto.minimo) && produto.minimo > 0) ? produto.minimo : 5;
            return produto.estoque > 0 && produto.estoque <= minimo;
        }).length;
        const valorTotal = this.produtos.reduce((total, produto) => total + ((produto.preco || 0) * (produto.estoque || 0)), 0);
        const listaEstoque = document.getElementById('estoque-lista');
        const contadorProdutos = listaEstoque ? listaEstoque.querySelectorAll('.produto-card-novo').length : this.produtos.length;
        
        // Atualizar elementos da interface
        const totalItensEl = document.getElementById('total-itens-estoque');
        const alertasEl = document.getElementById('alertas-estoque');
        const valorInventarioEl = document.getElementById('valor-inventario');
        const contadorProdutosEl = document.getElementById('contador-produtos');
        
        if (totalItensEl) totalItensEl.textContent = totalItens;
        if (alertasEl) alertasEl.textContent = alertas;
        if (valorInventarioEl) valorInventarioEl.textContent = `R$ ${valorTotal.toFixed(2).replace('.', ',')}`;
        if (contadorProdutosEl) contadorProdutosEl.textContent = `${contadorProdutos} ${contadorProdutos === 1 ? 'produto' : 'produtos'}`;
    }

    // Funções para estatísticas do dashboard executivo
    obterEstatisticasGerais() {
        const vendas = this.obterVendas();
        const hoje = new Date().toDateString();
        const vendasHoje = vendas.filter(venda => new Date(venda.data).toDateString() === hoje);
        
        // Estatísticas básicas
        const totalVendasHoje = vendasHoje.reduce((total, venda) => total + venda.totalVenda, 0);
        const totalLucroHoje = vendasHoje.reduce((total, venda) => total + venda.lucro, 0);
        const quantidadeVendasHoje = vendasHoje.length;
        
        // Produto mais vendido hoje
        const produtosVendidos = {};
        vendasHoje.forEach(venda => {
            venda.itens.forEach(item => {
                if (!produtosVendidos[item.nome]) {
                    produtosVendidos[item.nome] = 0;
                }
                produtosVendidos[item.nome] += item.quantidade;
            });
        });
        
        const produtoMaisVendido = Object.keys(produtosVendidos).reduce((a, b) => 
            produtosVendidos[a] > produtosVendidos[b] ? a : b, Object.keys(produtosVendidos)[0]
        ) || 'Nenhum';
        
        // Produtos com estoque baixo
        const produtosEstoqueBaixo = this.produtos.filter(p => p.estoque <= 5).length;
        
        return {
            totalVendasHoje,
            totalLucroHoje,
            quantidadeVendasHoje,
            produtoMaisVendido,
            produtosEstoqueBaixo,
            ticketMedio: quantidadeVendasHoje > 0 ? totalVendasHoje / quantidadeVendasHoje : 0
        };
    }

    obterVendasPorPeriodo(dias = 7) {
        const vendas = this.obterVendas();
        const hoje = new Date();
        const vendasPeriodo = [];
        
        for (let i = dias - 1; i >= 0; i--) {
            const data = new Date(hoje);
            data.setDate(data.getDate() - i);
            const dataString = data.toDateString();
            
            const vendasDia = vendas.filter(venda => 
                new Date(venda.data).toDateString() === dataString
            );
            
            const totalDia = vendasDia.reduce((total, venda) => total + venda.totalVenda, 0);
            const lucroDia = vendasDia.reduce((total, venda) => total + venda.lucro, 0);
            
            vendasPeriodo.push({
                data: data.toLocaleDateString('pt-BR'),
                vendas: totalDia,
                lucro: lucroDia,
                quantidade: vendasDia.length
            });
        }
        
        return vendasPeriodo;
    }

    obterProdutosMaisVendidos(limite = 5) {
        const vendas = this.obterVendas();
        const produtosVendidos = {};
        
        vendas.forEach(venda => {
            venda.itens.forEach(item => {
                if (!produtosVendidos[item.nome]) {
                    produtosVendidos[item.nome] = {
                        nome: item.nome,
                        quantidade: 0,
                        receita: 0
                    };
                }
                produtosVendidos[item.nome].quantidade += item.quantidade;
                produtosVendidos[item.nome].receita += item.preco * item.quantidade;
            });
        });
        
        return Object.values(produtosVendidos)
            .sort((a, b) => b.quantidade - a.quantidade)
            .slice(0, limite);
    }

    obterFormasPagamentoEstatisticas() {
        const vendas = this.obterVendas();
        const formasPagamento = {
            'dinheiro': { count: 0, total: 0 },
            'credito': { count: 0, total: 0 },
            'debito': { count: 0, total: 0 },
            'pix': { count: 0, total: 0 }
        };
        
        vendas.forEach(venda => {
            if (formasPagamento[venda.formaPagamento]) {
                formasPagamento[venda.formaPagamento].count++;
                formasPagamento[venda.formaPagamento].total += venda.totalVenda;
            }
        });
        
        return formasPagamento;
    }

    ajustarEstoque(id, quantidade) {
        const produto = this.getProdutoById(id);
        const novoEstoque = produto.estoque + quantidade;
        
        if (novoEstoque < 0) {
            this.mostrarModal('Erro', 'Estoque não pode ser negativo!', 'error');
            return;
        }
        
        const estoqueAnterior = produto.estoque || 0;
        produto.estoque = novoEstoque;
        
        // Registrar movimento de ajuste manual
        const tipo = quantidade >= 0 ? 'entrada' : 'saida';
        const quantidadeReal = Math.abs(quantidade);
        this.registrarMovimentoEstoque({
            id: 'M' + Date.now() + '-' + produto.id,
            data: new Date().toISOString(),
            tipo,
            origem: 'ajuste',
            produtoId: produto.id,
            nome: produto.nome,
            codigo: produto.codigo || '',
            categoria: produto.categoria || 'outros',
            fornecedor: produto.fornecedor || '',
            quantidade: quantidadeReal,
            estoqueAntes: estoqueAnterior,
            estoqueDepois: produto.estoque
        });
        
        this.salvarProdutos();
        this.atualizarEstoque();
        this.carregarProdutosSelect();
        this.mostrarToast('Estoque atualizado com sucesso!', 'success');
    }

    filtrarEstoque() {
        const termo = document.getElementById('buscar-produto')?.value.toLowerCase() || '';
        const cards = document.querySelectorAll('#estoque-lista .produto-card-novo');
        
        cards.forEach(card => {
            const nome = card.querySelector('.produto-nome')?.textContent.toLowerCase() || '';
            const categoria = card.querySelector('.produto-categoria-tag')?.textContent.toLowerCase() || '';
            const codigo = card.getAttribute('data-codigo')?.toLowerCase() || '';
            const descricao = card.getAttribute('data-descricao')?.toLowerCase() || '';
            const fornecedor = card.getAttribute('data-fornecedor')?.toLowerCase() || '';
            const localizacao = card.getAttribute('data-localizacao')?.toLowerCase() || '';
            const status = card.getAttribute('data-status')?.toLowerCase() || '';
            const corresponde = [nome, categoria, codigo, descricao, fornecedor, localizacao, status]
                .some(valor => valor.includes(termo));
            card.style.display = corresponde ? 'block' : 'none';
        });
        
        // Atualizar contador de produtos visíveis
        const contador = document.getElementById('contador-produtos');
        if (contador) {
            const produtosVisiveis = [...cards].filter(card => card.style.display !== 'none').length;
            contador.textContent = `${produtosVisiveis} ${produtosVisiveis === 1 ? 'produto' : 'produtos'}`;
        }
    }

    atualizarListaProdutos() {
        const lista = document.getElementById('produtos-lista');
        if (!lista) {
            console.error('Elemento produtos-lista não encontrado');
            return;
        }

        if (this.produtos.length === 0) {
            lista.innerHTML = `
                <div style="text-align: center; padding: 3rem; color: #b0b0b0;">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" style="margin-bottom: 1rem; opacity: 0.5;">
                        <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
                    </svg>
                    <h3 style="margin: 0 0 0.5rem 0; color: #666;">Nenhum produto cadastrado</h3>
                    <p style="margin: 0; font-size: 0.9rem;">Adicione produtos para começar a gerenciar seu inventário</p>
                </div>
            `;
            return;
        }

        this.exibirProdutosFiltrados();
    }

    exibirProdutosFiltrados(produtosFiltrados = null, targetId = 'produtos-lista') {
        const lista = document.getElementById(targetId);
        if (!lista) return;

        // Usa o input de busca correspondente ao target
        const buscaId = targetId === 'produtos-lista' ? 'search-produtos' : 'buscar-produto';
        const termoBusca = document.getElementById(buscaId)?.value.toLowerCase() || '';

        // Usa a lista fornecida (buscar-produto / ordenar) ou filtra por search-produtos
        const produtos = produtosFiltrados ?? this.produtos.filter(produto => {
            const nomeOk = produto.nome?.toLowerCase().includes(termoBusca);
            const catOk = produto.categoria?.toLowerCase().includes(termoBusca);
            const codOk = produto.codigo ? produto.codigo.toLowerCase().includes(termoBusca) : false;
            const descOk = produto.descricao ? produto.descricao.toLowerCase().includes(termoBusca) : false;
            return nomeOk || catOk || codOk || descOk;
        });

        // Coalescer renderização para evitar múltiplos updates consecutivos
        this._coalesce.renderRaf = this._coalesce.renderRaf || {};
        try { cancelAnimationFrame(this._coalesce.renderRaf[targetId]); } catch (_) {}
        this._coalesce.renderRaf[targetId] = requestAnimationFrame(() => {
            const html = produtos.map(produto => {
                const categoria = this.getCategoriaIcon(produto.categoria);
                const threshold = (Number.isFinite(produto.minimo) && produto.minimo > 0) ? produto.minimo : 5;
                const estoqueStatus = produto.estoque === 0 ? 'zero' : produto.estoque <= threshold ? 'baixo' : 'normal';
                const margem = produto.preco > 0 ? ((produto.preco - produto.custo) / produto.preco * 100).toFixed(1) : 0;
                return `
                <div class="produto-card-novo" data-categoria="${produto.categoria}" data-estoque="${estoqueStatus}">
                    <div class="produto-header-novo">
                        <h4 class="produto-nome">${produto.nome}</h4>
                        <span class="produto-categoria-tag">${categoria} ${produto.categoria}</span>
                        <div class="produto-status">
                            <span class="status-badge ${estoqueStatus === 'zero' ? 'sem-estoque' : estoqueStatus === 'baixo' ? 'estoque-baixo' : 'estoque-ok'}">
                                ${estoqueStatus === 'zero' ? 'SEM ESTOQUE' : estoqueStatus === 'baixo' ? 'ESTOQUE BAIXO' : 'ESTOQUE OK'}
                            </span>
                        </div>
                    </div>
                    
                    <div class="produto-preco-novo">
                        <span class="preco-simbolo">R$</span>
                        <span class="preco-valor">${produto.preco.toFixed(2).replace('.', ',')}</span>
                    </div>
                    
                    <div class="produto-detalhes-novo">
                        <div class="detalhe-row">
                            <span class="detalhe-label-novo">ESTOQUE</span>
                            <span class="detalhe-label-novo">CUSTO</span>
                            <span class="detalhe-label-novo">MARGEM</span>
                        </div>
                        <div class="detalhe-valores">
                            <span class="detalhe-valor-novo estoque-valor">${produto.estoque} un</span>
                            <span class="detalhe-valor-novo custo-valor">R$ ${(produto.custo || 0).toFixed(2).replace('.', ',')}</span>
                            <span class="detalhe-valor-novo margem-valor">${margem}%</span>
                        </div>
                    </div>
                    
                    <div class="produto-actions-novo">
                        <button class="btn-editar" onclick="editarProduto(${produto.id})">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="m18.5 2.5 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            Editar
                        </button>
                        <button class="btn-estoque" onclick="abrirModalEstoque(${produto.id})">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4m-4-4v8m0-8l3 3m-3-3l-3 3"/>
                            </svg>
                            Estoque
                        </button>
                        <button class="btn-excluir" onclick="excluirProduto(${produto.id})">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3,6 5,6 21,6"/>
                                <path d="m19,6v14a2,2 0 0,1 -2,2H7a2,2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2,2 0 0,1 2,2v2"/>
                            </svg>
                            Excluir
                        </button>
                    </div>
                </div>
            `;
            }).join('');
            lista.innerHTML = html;

            // Atualiza contador visível quando existir
            const contador = document.getElementById('contador-produtos');
            if (contador) {
                const qtd = produtos.length;
                contador.textContent = `${qtd} ${qtd === 1 ? 'produto' : 'produtos'}`;
            }
        });
    }

    // Inicializa selects de categoria e datalists com autocomplete
    inicializarFiltrosProdutos() {
        const categoriasUnicas = [...new Set(this.produtos.map(p => p.categoria))].sort();
        const selectInventario = document.getElementById('categoria-filtro-inventario');
        const selectEstoque = document.getElementById('categoria-filtro-estoque');

        [selectInventario, selectEstoque].forEach(sel => {
            if (!sel) return;
            // Garantir opção Todas
            if (![...sel.options].some(o => o.value === 'todas')) {
                const opt = document.createElement('option');
                opt.value = 'todas';
                opt.textContent = 'Todas';
                sel.insertBefore(opt, sel.firstChild);
            }
            categoriasUnicas.forEach(cat => {
                if (![...sel.options].some(o => o.value === cat)) {
                    const opt = document.createElement('option');
                    opt.value = cat;
                    opt.textContent = cat;
                    sel.appendChild(opt);
                }
            });
            sel.addEventListener('change', () => {
                const targetId = sel.id.includes('inventario') ? 'produtos-lista' : 'estoque-lista';
                this.aplicarFiltrosCombinados(targetId);
            });
        });

        // Autocomplete de nomes e categorias
        const sugestoes = [...new Set(this.produtos.flatMap(p => [p.nome, p.categoria]))].sort();
        const dlInventario = document.getElementById('sugestoes-inventario');
        const dlEstoque = document.getElementById('sugestoes-estoque');
        [dlInventario, dlEstoque].forEach(dl => {
            if (!dl) return;
            dl.innerHTML = sugestoes.map(s => `<option value="${s}"></option>`).join('');
        });

        // Listeners de busca
        const inputInventario = document.getElementById('search-produtos');
        const inputEstoque = document.getElementById('buscar-produto');
        if (inputInventario) inputInventario.addEventListener('input', this._debounce(() => this.aplicarFiltrosCombinados('produtos-lista'), 150));
        if (inputEstoque) inputEstoque.addEventListener('input', this._debounce(() => this.aplicarFiltrosCombinados('estoque-lista'), 150));

        // Listeners de preço
        const minInv = document.getElementById('preco-min-inventario');
        const maxInv = document.getElementById('preco-max-inventario');
        const minEst = document.getElementById('preco-min-estoque');
        const maxEst = document.getElementById('preco-max-estoque');
        [minInv, maxInv].forEach(inp => { if (inp) inp.addEventListener('input', this._debounce(() => this.aplicarFiltrosCombinados('produtos-lista'), 150)); });
        [minEst, maxEst].forEach(inp => { if (inp) inp.addEventListener('input', this._debounce(() => this.aplicarFiltrosCombinados('estoque-lista'), 150)); });
    }

    // Aplica filtros por categoria, preço e aba de status
    aplicarFiltrosCombinados(targetId = 'produtos-lista') {
        try { clearTimeout(this._coalesce.filtrosTimer); } catch (_) {}
        this._coalesce.filtrosTimer = setTimeout(() => {
            const getVal = (id) => {
                const el = document.getElementById(id);
                return el ? el.value : '';
            };

            const buscaId = targetId === 'produtos-lista' ? 'search-produtos' : 'buscar-produto';
            const categoriaId = targetId === 'produtos-lista' ? 'categoria-filtro-inventario' : 'categoria-filtro-estoque';
            const minId = targetId === 'produtos-lista' ? 'preco-min-inventario' : 'preco-min-estoque';
            const maxId = targetId === 'produtos-lista' ? 'preco-max-inventario' : 'preco-max-estoque';
            const tabsSel = targetId === 'produtos-lista' ? '.filter-tabs .filter-tab.active' : '.filter-tabs-novo .filter-tab-novo.active';

            const termo = getVal(buscaId).toLowerCase();
            const categoriaSel = getVal(categoriaId);
            const minStr = getVal(minId);
            const maxStr = getVal(maxId);
            const min = minStr ? parseFloat(minStr.replace(',', '.')) : NaN;
            const max = maxStr ? parseFloat(maxStr.replace(',', '.')) : NaN;
            const activeTab = document.querySelector(tabsSel);

            let statusFiltro = 'todos';
            if (activeTab) {
                const texto = activeTab.textContent.trim().toLowerCase();
                if (texto.includes('sem')) statusFiltro = 'sem-estoque';
                else if (texto.includes('baixo')) statusFiltro = 'baixo-estoque';
                else statusFiltro = 'todos';
            }

            const filtrados = this.produtos.filter(p => {
                const termoOk = !termo ||
                    (p.nome && p.nome.toLowerCase().includes(termo)) ||
                    (p.categoria && p.categoria.toLowerCase().includes(termo)) ||
                    (p.codigo && p.codigo.toLowerCase().includes(termo)) ||
                    (p.descricao && p.descricao.toLowerCase().includes(termo));
                const catOk = !categoriaSel || categoriaSel === 'todas' || p.categoria === categoriaSel || (p.categoria && p.categoria.toLowerCase() === categoriaSel.toLowerCase());
                const minOk = isNaN(min) || p.preco >= min;
                const maxOk = isNaN(max) || p.preco <= max;
                const threshold = (Number.isFinite(p.minimo) && p.minimo > 0) ? p.minimo : 5;
                let statusOk = true;
                if (statusFiltro === 'sem-estoque') statusOk = p.estoque === 0;
                else if (statusFiltro === 'baixo-estoque') statusOk = p.estoque > 0 && p.estoque <= threshold;
                return termoOk && catOk && minOk && maxOk && statusOk;
            });

            this.exibirProdutosFiltrados(filtrados, targetId);
        }, 120);
    }

    // Função para obter ícone da categoria
    getCategoriaIcon(categoria) {
        const icons = {
            'cigarros': '🚬',
            'bebidas': '🥤',
            'doces': '🍬',
            'salgados': '🥨',
            'outros': '📦'
        };
        return icons[categoria.toLowerCase()] || '📦';
    }

    // Função para atualizar estatísticas de produtos
    atualizarEstatisticasProdutos() {
        const totalProdutos = document.getElementById('total-produtos');
        const produtosBaixoEstoque = document.getElementById('produtos-baixo-estoque');
        const valorTotalEstoque = document.getElementById('valor-total-estoque');
        const produtosTabBadgeEl = document.getElementById('produtos-tab-badge');
        
        if (totalProdutos) {
            totalProdutos.textContent = this.produtos.length;
        }
        
        if (produtosBaixoEstoque) {
            const baixoEstoque = this.produtos.filter(p => {
                const threshold = (Number.isFinite(p.minimo) && p.minimo > 0) ? p.minimo : 5;
                return p.estoque > 0 && p.estoque <= threshold;
            }).length;
            produtosBaixoEstoque.textContent = baixoEstoque;
        }
        
        if (valorTotalEstoque) {
            const valorTotal = this.produtos.reduce((total, produto) => {
                return total + (produto.custo * produto.estoque);
            }, 0);
            valorTotalEstoque.textContent = `R$ ${valorTotal.toFixed(2).replace('.', ',')}`;
        }

        if (produtosTabBadgeEl) {
            produtosTabBadgeEl.textContent = String(this.produtos.length);
        }
    }

    removerProduto(id) {
        if (confirm('Tem certeza que deseja remover este produto?')) {
            this.produtos = this.produtos.filter(p => p.id !== id);
            this.salvarProdutos();
            this.carregarProdutosSelect();
            this.atualizarEstoque();
            this.atualizarListaProdutos();
            this.atualizarEstatisticasProdutos();
            this.mostrarModal('Sucesso', 'Produto removido com sucesso!', 'success');
        }
    }

    imprimirComprovante(dadosVenda) {
        const { totalCompra, lucroVenda, itens, formaPagamento, valorRecebido, vendedor } = dadosVenda;
        
        const formas = {
            'dinheiro': 'Dinheiro',
            'credito': 'Cartão de Crédito',
            'debito': 'Cartão de Débito',
            'pix': 'PIX'
        };
        
        const agora = new Date();
        const dataHora = agora.toLocaleString('pt-BR');
        
        let itensHtml = '';
        itens.forEach(item => {
            const subtotal = item.preco * item.quantidade;
            itensHtml += `
                <tr>
                    <td style="padding: 5px; border-bottom: 1px solid #ddd;">${item.nome}</td>
                    <td style="padding: 5px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantidade}</td>
                    <td style="padding: 5px; border-bottom: 1px solid #ddd; text-align: right;">R$ ${item.preco.toFixed(2).replace('.', ',')}</td>
                    <td style="padding: 5px; border-bottom: 1px solid #ddd; text-align: right;">R$ ${subtotal.toFixed(2).replace('.', ',')}</td>
                </tr>
            `;
        });
        
        let pagamentoInfo = '';
        if (formaPagamento === 'dinheiro' && valorRecebido) {
            const troco = valorRecebido - totalCompra;
            pagamentoInfo = `
                <p><strong>Valor Recebido:</strong> R$ ${valorRecebido.toFixed(2).replace('.', ',')}</p>
                <p><strong>Troco:</strong> R$ ${troco.toFixed(2).replace('.', ',')}</p>
            `;
        }
        
        const comprovanteHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Comprovante de Venda</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    .header { text-align: center; margin-bottom: 20px; }
                    .info { margin-bottom: 15px; }
                    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
                    th { background-color: #f5f5f5; padding: 8px; border: 1px solid #ddd; }
                    .total { font-size: 18px; font-weight: bold; margin-top: 15px; }
                    .footer { margin-top: 20px; text-align: center; font-size: 12px; color: #666; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h2>📋 HidenSystems</h2>
                    <p>Comprovante de Venda</p>
                </div>
                
                <div class="info">
                    <p><strong>Data/Hora:</strong> ${dataHora}</p>
                    <p><strong>Forma de Pagamento:</strong> ${formas[formaPagamento]}</p>
                    ${vendedor ? `<p><strong>Vendedor:</strong> ${vendedor.nome}${vendedor.contato ? ' — ' + vendedor.contato : ''}</p>` : ''}
                </div>
                
                <table>
                    <thead>
                        <tr>
                            <th>Produto</th>
                            <th>Qtd</th>
                            <th>Preço Unit.</th>
                            <th>Subtotal</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itensHtml}
                    </tbody>
                </table>
                
                <div class="total">
                    <p><strong>TOTAL: R$ ${totalCompra.toFixed(2).replace('.', ',')}</strong></p>
                    ${pagamentoInfo}
                </div>
                
                <div class="footer">
                    <p>Obrigado pela preferência!</p>
                    <p>Sistema de Gestão - HidenSystems</p>
                </div>
            </body>
            </html>
        `;
        
        // Abrir nova janela para impressão
        const janelaImpressao = window.open('', '_blank');
        janelaImpressao.document.write(comprovanteHtml);
        janelaImpressao.document.close();
        
        // Aguardar carregamento e imprimir
        janelaImpressao.onload = function() {
            janelaImpressao.print();
            janelaImpressao.close();
        };
        
        // Mostrar toast de confirmação
        this.mostrarToast('🖨️ Comprovante enviado para impressão!', 'success');
    }

    mostrarToast(mensagem, tipo = 'success', duracao = 3000) {
        // Criar container de toast se não existir
        let toastContainer = document.getElementById('toast-container');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'toast-container';
            toastContainer.className = 'toast-container';
            document.body.appendChild(toastContainer);
        }
        
        // Criar toast
        const toast = document.createElement('div');
        toast.className = `toast ${tipo}`;
        
        const iconMap = {
            success: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
            error: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
            warning: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="m12 17 .01 0"/></svg>`
        };
        
        toast.innerHTML = `
            <div class="toast-icon ${tipo}">
                ${iconMap[tipo]}
            </div>
            <div class="toast-content">
                <div class="toast-message">${mensagem}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        `;
        
        toastContainer.appendChild(toast);
        
        // Auto-remover após duração especificada
        setTimeout(() => {
            if (toast.parentElement) {
                toast.style.animation = 'slideOutRight 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }
        }, duracao);
    }

    mostrarModalVenda(dadosVenda) {
        const modal = document.getElementById('modal');
        const modalBody = document.getElementById('modal-body');
        
        // Extrair dados com validação
        const { totalCompra, lucroVenda, itens, formaPagamento, valorRecebido, vendedor } = dadosVenda;
        
        // Debug detalhado
        console.log('=== DEBUG MODAL VENDA ===');
        console.log('Dados completos:', dadosVenda);
        console.log('Itens:', itens);
        console.log('Forma de pagamento:', formaPagamento);
        console.log('Valor recebido:', valorRecebido);
        
        // Mapeamento das formas de pagamento
        const formasPagamento = {
            'dinheiro': 'Dinheiro',
            'credito': 'Cartão de Crédito',
            'debito': 'Cartão de Débito',
            'pix': 'PIX'
        };
        
        // Função para formatação monetária
        const formatarMoeda = (valor) => {
            if (typeof valor !== 'number' || isNaN(valor)) {
                return 'R$ 0,00';
            }
            return valor.toLocaleString('pt-BR', { 
                style: 'currency', 
                currency: 'BRL' 
            });
        };
        
        // Validar se há itens
        if (!itens || !Array.isArray(itens) || itens.length === 0) {
            console.error('Erro: Nenhum item encontrado na venda ou itens inválidos');
            modalBody.innerHTML = `
                <div class="notification-header error">
                    <h3>Erro na Venda</h3>
                </div>
                <div class="notification-body">
                    <p>Não foi possível exibir os detalhes da venda. Nenhum item encontrado.</p>
                </div>
                <div class="notification-actions">
                    <button class="btn-notification primary" onclick="fecharModal()">OK</button>
                </div>
            `;
            modal.style.display = 'block';
            return;
        }
        
        // Construir lista de itens vendidos
        let itensHtml = '';
        let totalItensVerificacao = 0;
        
        itens.forEach((item, index) => {
            console.log(`Item ${index + 1}:`, item);
            
            // Validar dados do item
            const nome = item.nome || 'Produto sem nome';
            const quantidade = item.quantidade || 1;
            const preco = item.preco || 0;
            const subtotal = preco * quantidade;
            
            totalItensVerificacao += subtotal;
            
            itensHtml += `
                <div class="item-venda-linha" style="padding: 0.75rem 0; border-bottom: 1px solid #e9ecef; font-size: 0.95rem;">
                    <strong>- ${nome}</strong> (x${quantidade}) — ${formatarMoeda(subtotal)}
                </div>
            `;
        });
        
        console.log('Total calculado dos itens:', totalItensVerificacao);
        console.log('Total da compra informado:', totalCompra);
        
        // Determinar forma de pagamento
        let formaPagamentoTexto = 'Não informado';
        if (formaPagamento && typeof formaPagamento === 'string') {
            formaPagamentoTexto = formasPagamento[formaPagamento.toLowerCase()] || formaPagamento;
        }
        
        console.log('Forma de pagamento final:', formaPagamentoTexto);
        
        // Construir informações de pagamento (troco para dinheiro)
        let pagamentoInfo = '';
        if (formaPagamento === 'dinheiro' && valorRecebido && valorRecebido > 0) {
            const troco = valorRecebido - totalCompra;
            if (troco > 0) {
                pagamentoInfo = `
                    <div class="pagamento-detalhes" style="margin-top: 1rem; padding: 1rem; background: #e8f5e8; border-radius: 8px; border-left: 4px solid #28a745;">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                            <span style="font-weight: 500;">💵 Valor recebido:</span>
                            <span style="font-weight: bold; color: #155724;">${formatarMoeda(valorRecebido)}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="font-weight: 500;">💰 Troco:</span>
                            <span style="font-weight: bold; color: #28a745; font-size: 1.1rem;">${formatarMoeda(troco)}</span>
                        </div>
                    </div>
                `;
            }
        }
        
        // Construir HTML do modal
        modalBody.innerHTML = `
            <div class="notification-header success" style="background: linear-gradient(135deg, #28a745, #20c997); color: white; padding: 1.5rem; border-radius: 12px 12px 0 0; text-align: center;">
                <div class="notification-icon success" style="margin-bottom: 0.5rem;">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M20 6L9 17l-5-5"/>
                    </svg>
                </div>
                <h3 class="notification-title" style="margin: 0; font-size: 1.4rem; font-weight: 600;">✅ Venda Finalizada com Sucesso!</h3>
            </div>
            
            <div class="notification-body" style="padding: 2rem;">
                <div class="venda-resumo">
                    <!-- Seção Vendedor -->
                    ${vendedor ? `
                    <div class="resumo-section" style="margin-bottom: 2rem;">
                        <h4 style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; color: #333; font-size: 1.1rem; font-weight: 600;">
                            👤 Vendedor:
                        </h4>
                        <div style="background: #f8f9fa; padding: 1rem; border-radius: 8px; border-left: 4px solid #6f42c1;">
                            <span style="font-weight: bold; color: #6f42c1;">${vendedor.nome}${vendedor.contato ? ' — ' + vendedor.contato : ''}</span>
                        </div>
                    </div>
                    ` : ''}
                    <!-- Seção Itens Vendidos -->
                    <div class="resumo-section" style="margin-bottom: 2rem;">
                        <h4 style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; color: #333; font-size: 1.1rem; font-weight: 600;">
                            📦 Itens Vendidos:
                        </h4>
                        <div class="itens-lista" style="background: #f8f9fa; padding: 1.25rem; border-radius: 8px; border-left: 4px solid #28a745; max-height: 200px; overflow-y: auto;">
                            ${itensHtml}
                        </div>
                    </div>
                    
                    <!-- Seção Forma de Pagamento -->
                    <div class="resumo-section" style="margin-bottom: 2rem;">
                        <h4 style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; color: #333; font-size: 1.1rem; font-weight: 600;">
                            💳 Forma de Pagamento:
                        </h4>
                        <div style="background: linear-gradient(135deg, #e3f2fd, #bbdefb); padding: 1rem; border-radius: 8px; border-left: 4px solid #2196f3;">
                            <span style="font-weight: bold; color: #1565c0; font-size: 1.1rem;">${formaPagamentoTexto}</span>
                        </div>
                        ${pagamentoInfo}
                    </div>
                    
                    <!-- Seção Resumo Financeiro -->
                    <div class="resumo-section">
                        <h4 style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; color: #333; font-size: 1.1rem; font-weight: 600;">
                            💰 Resumo Financeiro:
                        </h4>
                        <div class="financeiro-resumo" style="background: #f8f9fa; padding: 1.25rem; border-radius: 8px; border: 1px solid #dee2e6;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 2px solid #28a745;">
                                <span style="font-weight: 600; font-size: 1.1rem;">💵 Total da Venda:</span>
                                <span style="font-weight: bold; color: #28a745; font-size: 1.4rem;">${formatarMoeda(totalCompra)}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                <span style="font-weight: 600; font-size: 1rem;">📈 Lucro Obtido:</span>
                                <span style="font-weight: bold; color: #fd7e14; font-size: 1.2rem;">${formatarMoeda(lucroVenda)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="notification-actions" style="padding: 1.5rem; background: #f8f9fa; display: flex; justify-content: space-between; gap: 1rem; border-radius: 0 0 12px 12px;">
                <button class="btn-notification secondary" onclick="sistema.imprimirComprovante({totalCompra: ${totalCompra}, lucroVenda: ${lucroVenda}, itens: ${JSON.stringify(itens).replace(/\"/g, '&quot;')}, formaPagamento: '${formaPagamento}', valorRecebido: ${valorRecebido || 'null'}, vendedor: ${vendedor ? JSON.stringify(vendedor).replace(/\"/g, '&quot;') : 'null'}})" style="flex: 1; padding: 0.75rem 1rem; background: #6c757d; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">
                    🖨️ Imprimir Comprovante
                </button>
                <button class="btn-notification primary" onclick="fecharModal()" style="flex: 1; padding: 0.75rem 1rem; background: #007bff; color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer;">
                    ✅ OK
                </button>
            </div>
        `;
        
        // Exibir modal
        modal.style.display = 'block';
        
        // Auto-fechar após 10 segundos
        setTimeout(() => {
            if (modal.style.display === 'block') {
                modal.style.display = 'none';
            }
        }, 10000);
    }

    mostrarModal(titulo, mensagem, tipo) {
        const modal = document.getElementById('modal');
        const modalBody = document.getElementById('modal-body');
        
        const iconMap = {
            'success': `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 6L9 17l-5-5"/>
            </svg>`,
            'error': `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>`,
            'warning': `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>`
        };
        
        const icon = iconMap[tipo] || '!';
        
        modalBody.innerHTML = `
            <div class="notification-header ${tipo}">
                <div class="notification-icon ${tipo}">${icon}</div>
                <h3 class="notification-title">${titulo}</h3>
            </div>
            <div class="notification-body">
                <p class="notification-message">${mensagem.replace(/\n/g, '<br>')}</p>
            </div>
            <div class="notification-actions">
                <button class="btn-notification primary" onclick="fecharModal()">OK</button>
            </div>
        `;
        
        modal.style.display = 'block';
        
        // Auto-fechar após 5 segundos para mensagens de sucesso
        if (tipo === 'success') {
            setTimeout(() => {
                if (modal.style.display === 'block') {
                    modal.style.display = 'none';
                }
            }, 5000);
        }
    }
    
    // Nova função para toast notifications
    mostrarToast(titulo, mensagem, tipo = 'success', duracao = 4000) {
        const container = document.getElementById('toast-container');
        const toastId = 'toast-' + Date.now();
        
        const iconMap = {
            'success': '✓',
            'error': '✕',
            'warning': '⚠'
        };
        
        const icon = iconMap[tipo] || '!';
        
        const toast = document.createElement('div');
        toast.className = `toast ${tipo}`;
        toast.id = toastId;
        toast.innerHTML = `
            <div class="toast-icon">${icon}</div>
            <div class="toast-content">
                <div class="toast-title">${titulo}</div>
                <div class="toast-message">${mensagem}</div>
            </div>
            <button class="toast-close" onclick="removerToast('${toastId}')">&times;</button>
        `;
        
        container.appendChild(toast);
        
        // Auto-remover após a duração especificada
        setTimeout(() => {
            this.removerToast(toastId);
        }, duracao);
    }
    
    removerToast(toastId) {
        const toast = document.getElementById(toastId);
        if (toast) {
            toast.style.animation = 'slideOutRight 0.3s ease';
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        }
    }
}

// Funções globais para os event handlers


// Função para ajustar quantidade
function adjustQuantity(change) {
    const quantidadeInput = document.getElementById('quantidade');
    let quantidade = parseInt(quantidadeInput.value) || 1;
    quantidade += change;
    
    if (quantidade < 1) quantidade = 1;
    
    quantidadeInput.value = quantidade;
    atualizarTotalItem();
}

// Função para atualizar total do item
function atualizarTotalItem() {
    const select = document.getElementById('produto-select');
    const quantidade = parseInt(document.getElementById('quantidade').value) || 1;
    const totalItemElement = document.getElementById('total-item');
    
    if (select.value && totalItemElement) {
        const produto = sistema.produtos.find(p => p.id == select.value);
        if (produto) {
            const total = produto.preco * quantidade;
            totalItemElement.textContent = `R$ ${total.toFixed(2).replace('.', ',')}`;
        }
    } else if (totalItemElement) {
        totalItemElement.textContent = 'R$ 0,00';
    }
}

// Função para atualizar estatísticas do dashboard
function atualizarEstatisticas() {
    const stats = sistema.obterEstatisticasGerais();
    
    // Atualizar vendas hoje (quantidade)
    const vendasHojeElement = document.getElementById('vendas-hoje');
    if (vendasHojeElement) {
        vendasHojeElement.textContent = stats.quantidadeVendasHoje;
    }
    
    // Atualizar vendas hoje (valor)
    const vendasHojeValorElement = document.getElementById('vendas-hoje-valor');
    if (vendasHojeValorElement) {
        vendasHojeValorElement.textContent = `R$ ${stats.totalVendasHoje.toFixed(2).replace('.', ',')}`;
    }
    
    // Atualizar ticket médio
    const ticketMedioElement = document.getElementById('ticket-medio');
    if (ticketMedioElement) {
        ticketMedioElement.textContent = `R$ ${stats.ticketMedio.toFixed(0)}`;
    }
    
    // Novo: atualizar o card "Quantidade de Vendas" nos Relatórios
    const quantidadeHojeCardElement = document.getElementById('quantidade-hoje');
    if (quantidadeHojeCardElement) {
        quantidadeHojeCardElement.textContent = stats.quantidadeVendasHoje;
    }
}

// Função para filtrar produtos - VERSÃO CORRIGIDA
function filtrarProdutos(filtro, elemento = null) {
    console.log('Filtro aplicado:', filtro);

    // Aguardar um pouco para garantir que os produtos estejam renderizados
    setTimeout(() => {
        const cards = document.querySelectorAll('.produto-card-novo');
        const tabsNovo = document.querySelectorAll('.filter-tab-novo');
        const tabsInventario = document.querySelectorAll('.filter-tabs .filter-tab');

        console.log('Cards encontrados:', cards.length);

        // Se não há cards, tentar novamente após re-renderização
        if (cards.length === 0) {
            const targetId = elemento && elemento.classList.contains('filter-tab-novo') ? 'estoque-lista' : 'produtos-lista';
            if (typeof sistema !== 'undefined') {
                if (targetId === 'estoque-lista' && sistema.atualizarEstoque) {
                    sistema.atualizarEstoque();
                } else if (sistema.atualizarListaProdutos) {
                    sistema.atualizarListaProdutos();
                }
                if (sistema.aplicarFiltrosCombinados) {
                    sistema.aplicarFiltrosCombinados(targetId);
                }
                setTimeout(() => filtrarProdutos(filtro, elemento), 100);
            }
            return;
        }

        // Atualizar tabs ativas (bloco "Buscar Produtos")
        tabsNovo.forEach(tab => tab.classList.remove('active'));
        const targetElement = elemento || (typeof event !== 'undefined' ? event.target : null);
        if (targetElement && targetElement.classList.contains('filter-tab-novo')) {
            targetElement.classList.add('active');
        }

        // Atualizar tabs ativas (bloco "Inventário")
        if (tabsInventario.length) {
            tabsInventario.forEach(tab => tab.classList.remove('active'));
            const map = { 'todos': 0, 'baixo-estoque': 1, 'sem-estoque': 2 };
            const idx = map[filtro];
            if (typeof idx !== 'undefined' && tabsInventario[idx]) {
                tabsInventario[idx].classList.add('active');
            }
        }

        // Usar lógica combinada considerando o tab ativo recém clicado
        const targetId = elemento && elemento.classList.contains('filter-tab-novo') ? 'estoque-lista' : 'produtos-lista';
        if (typeof sistema !== 'undefined' && sistema.aplicarFiltrosCombinados) {
            sistema.aplicarFiltrosCombinados(targetId);
        }

    }, 50); // Delay pequeno para garantir renderização
}

// Função para buscar produtos
function buscarProdutos() {
    // Usa a lógica combinada de filtros no inventário
    sistema.aplicarFiltrosCombinados('produtos-lista');
}

function adicionarItem() {
    sistema.adicionarItem();
}

function selecionarPagamento(tipo, elemento = null) {
    sistema.selecionarPagamento(tipo, elemento);
}

// Funções globais de vendedores
function cadastrarVendedor() {
    sistema.cadastrarVendedor();
}

function excluirVendedor(id) {
    sistema.excluirVendedor(id);
}

function alterarStatusVendedor(id, status) {
    sistema.alterarStatusVendedor(id, status);
}

// Novo: edição de vendedores
function editarVendedor(id) {
    sistema.abrirModalEditarVendedor(id);
}

function salvarEdicaoVendedor(id) {
    sistema.salvarEdicaoVendedor(id);
}

// Wrapper global para filtros de vendedores
function filtrarVendedoresStatus(status, elemento = null) {
    sistema.filtrarVendedoresStatus(status, elemento);
}

function finalizarVenda() {
    sistema.finalizarVenda();
}

function adicionarProduto() {
    sistema.adicionarProduto();
}

function filtrarEstoque() {
    sistema.filtrarEstoque();
}

function filtrarRelatorio() {
    const dataInicio = document.getElementById('data-inicio').value;
    const dataFim = document.getElementById('data-fim').value;
    const vendedorFiltro = document.getElementById('vendedor-relatorio-select')?.value || '';
    
    if (!dataInicio || !dataFim) {
        sistema.mostrarModal('Erro', 'Selecione as datas de início e fim!', 'error');
        return;
    }
    
    if (new Date(dataInicio) > new Date(dataFim)) {
        sistema.mostrarModal('Erro', 'Data de início deve ser anterior à data de fim!', 'error');
        return;
    }
    
    let vendas = sistema.obterVendas(dataInicio, dataFim);
    // Aplicar filtro por vendedor, se selecionado
    if (vendedorFiltro) {
        vendas = vendas.filter(v => sistema.correspondeVendedor(v.vendedor, vendedorFiltro));
    }
    const resumo = sistema.calcularResumoFinanceiro(vendas);
    
    document.getElementById('vendas-hoje-valor').textContent = `R$ ${resumo.vendas.toFixed(2).replace('.', ',')}`;
    document.getElementById('gastos-hoje').textContent = `R$ ${resumo.custos.toFixed(2).replace('.', ',')}`;
    document.getElementById('lucro-hoje').textContent = `R$ ${resumo.lucro.toFixed(2).replace('.', ',')}`;

    // Atualizar margem média
    const margemMediaEl = document.getElementById('margem-media');
    if (margemMediaEl) {
        const margemMedia = resumo.vendas > 0 ? ((resumo.lucro / resumo.vendas) * 100) : 0;
        margemMediaEl.textContent = `${margemMedia.toFixed(1)}%`;
    }
    
    sistema.atualizarHistoricoVendas(vendas);
    // Preencher novas seções com base no período filtrado
    sistema.atualizarResumoPeriodo(vendas);
    sistema.atualizarTopProdutosPeriodo(vendas);
    sistema.atualizarVendasPorDiaPeriodo(vendas);
    // Nova: Atualizar sub-aba de Análise Detalhada
    if (typeof sistema.atualizarAnaliseDetalhadaPeriodo === 'function') {
        sistema.atualizarAnaliseDetalhadaPeriodo(vendas);
    }
}

function limparFiltro() {
    sistema.inicializarDatasRelatorio();
    const vendedorSelectRel = document.getElementById('vendedor-relatorio-select');
    if (vendedorSelectRel) vendedorSelectRel.value = '';
    sistema.atualizarRelatorios();
}

function limparFormulario() {
    sistema.limparFormulario();
}

function calcularPreviewLucro() {
    sistema.calcularMargemLucro();
    
    if (preco > 0 && custo > 0 && custo < preco) {
        const lucro = preco - custo;
        const margemLucro = ((lucro / preco) * 100).toFixed(1);
        profitValue.textContent = `${margemLucro}%`;
        profitPreview.style.display = 'block';
        
        // Cor baseada na margem
        if (margemLucro >= 30) {
            profitValue.style.color = '#155724'; // Verde escuro
        } else if (margemLucro >= 15) {
            profitValue.style.color = '#856404'; // Amarelo escuro
        } else {
            profitValue.style.color = '#721c24'; // Vermelho escuro
        }
    } else {
        profitPreview.style.display = 'none';
    }
}

function buscarProdutosPorNome() {
    // Agora utiliza a lógica combinada de filtros
    sistema.aplicarFiltrosCombinados('estoque-lista');
}

function ordenarProdutos() {
    const criterio = document.getElementById('ordenar-produtos').value;
    let produtosOrdenados = [...sistema.produtos];
    
    switch(criterio) {
        case 'nome':
            produtosOrdenados.sort((a, b) => a.nome.localeCompare(b.nome));
            break;
        case 'preco':
            produtosOrdenados.sort((a, b) => b.preco - a.preco);
            break;
        case 'quantidade':
            produtosOrdenados.sort((a, b) => b.quantidade - a.quantidade);
            break;
    }
    
    sistema.exibirProdutosFiltrados(produtosOrdenados);
}

function editarProduto(id) {
    const produto = sistema.getProdutoById(id);
    if (!produto) return;
    
    // Preencher formulário com dados do produto
    document.getElementById('produto-nome').value = produto.nome;
    document.getElementById('produto-preco').value = produto.preco;
    document.getElementById('produto-custo').value = produto.custo;
    document.getElementById('produto-estoque').value = produto.estoque || produto.quantidade;
    document.getElementById('produto-categoria').value = produto.categoria || 'outros';
    if (document.getElementById('produto-codigo')) document.getElementById('produto-codigo').value = produto.codigo || '';
    if (document.getElementById('produto-fornecedor')) document.getElementById('produto-fornecedor').value = produto.fornecedor || '';
    if (document.getElementById('produto-minimo')) document.getElementById('produto-minimo').value = Number.isFinite(produto.minimo) ? produto.minimo : 0;
    if (document.getElementById('produto-descricao')) document.getElementById('produto-descricao').value = produto.descricao || '';
    
    // Calcular margem de lucro
    sistema.calcularMargemLucro();
    
    // Marcar que estamos editando um produto
    sistema.produtoEditando = id;
    
    // Alterar interface para modo edição
    const botaoAdicionar = document.querySelector('.btn-primary');
    const botaoCancelar = document.querySelector('.btn-cancelar');
    
    if (botaoAdicionar) {
        botaoAdicionar.textContent = '✏️ Atualizar Produto';
    }
    if (botaoCancelar) {
        botaoCancelar.style.display = 'inline-block';
    }
    
    // Scroll para o formulário
    const formContainer = document.querySelector('.produto-form-container') || document.getElementById('produto-form');
    if (formContainer) {
        formContainer.scrollIntoView({ behavior: 'smooth' });
    }
}

function cancelarEdicao() {
    // Resetar modo de edição
    sistema.produtoEditando = null;
    
    // Restaurar interface
    const botaoAdicionar = document.querySelector('.btn-primary');
    const botaoCancelar = document.querySelector('.btn-cancelar');
    
    if (botaoAdicionar) {
        botaoAdicionar.textContent = '✅ Adicionar Produto';
    }
    if (botaoCancelar) {
        botaoCancelar.style.display = 'none';
    }
    
    // Limpar formulário
    limparFormulario();
}

function excluirProduto(id) {
    const produto = sistema.getProdutoById(id);
    if (!produto) return;
    
    if (confirm(`Tem certeza que deseja excluir o produto "${produto.nome}"?`)) {
        sistema.produtos = sistema.produtos.filter(p => p.id !== id);
        sistema.salvarDados();
        sistema.atualizarListaProdutos();
        sistema.atualizarEstoque();
        // Atualiza estatísticas e badge de produtos
        if (typeof sistema.atualizarEstatisticasProdutos === 'function') {
            sistema.atualizarEstatisticasProdutos();
        }
        sistema.mostrarModal('Sucesso', `Produto "${produto.nome}" excluído com sucesso!`, 'success');
    }
}

function fecharModal() {
    document.getElementById('modal').style.display = 'none';
}

function removerToast(toastId) {
    const toast = document.getElementById(toastId);
    if (toast) {
        toast.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }
}

// Função para baixar histórico em PDF
function baixarHistoricoPDF() {
    try {
        // Respeitar filtros atuais (datas e vendedor)
        const dataInicio = document.getElementById('data-inicio')?.value || '';
        const dataFim = document.getElementById('data-fim')?.value || '';
        const vendedorFiltro = document.getElementById('vendedor-relatorio-select')?.value || '';
        // Base de vendas conforme período selecionado
        let vendasBase = sistema.obterVendas(dataInicio && dataFim ? dataInicio : null, dataInicio && dataFim ? dataFim : null);
        // Aplicar filtro por vendedor, se houver
        let vendas = vendedorFiltro ? vendasBase.filter(v => sistema.correspondeVendedor(v.vendedor, vendedorFiltro)) : vendasBase.slice();

        // Fallbacks quando filtros zeram a lista
        let fallbackVendedor = false;
        let fallbackPeriodo = false;
        if (vendas.length === 0) {
            // 1) Remover filtro de vendedor se estava aplicado
            if (vendedorFiltro) {
                vendas = vendasBase.slice();
                fallbackVendedor = true;
            }
        }
        if (vendas.length === 0) {
            // 2) Remover filtro de período (trazer histórico completo)
            if (dataInicio && dataFim) {
                vendasBase = sistema.obterVendas(null, null);
                vendas = fallbackVendedor && vendedorFiltro
                    ? vendasBase.slice() // já removemos vendedor; mantém completo
                    : (vendedorFiltro ? vendasBase.filter(v => sistema.correspondeVendedor(v.vendedor, vendedorFiltro)) : vendasBase.slice());
                fallbackPeriodo = true;
                // Se ainda assim zerou por manter vendedor, remove também vendedor
                if (vendas.length === 0 && vendedorFiltro) {
                    vendas = vendasBase.slice();
                    fallbackVendedor = true;
                }
            }
        }

        if (vendas.length === 0) {
            sistema.mostrarToast('Aviso', 'Não há vendas para exportar!', 'warning');
            return;
        }
        
        // Criar conteúdo HTML para impressão
        const dataAtual = new Date().toLocaleDateString('pt-BR');
        const horaAtual = new Date().toLocaleTimeString('pt-BR');
        
        let htmlContent = `
            <html>
            <head>
                <title>Histórico de Vendas - HidenSystems</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 20px; }
                    .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 20px; }
                    .header h1 { color: #333; margin: 0; }
                    .header p { color: #666; margin: 5px 0; }
                    .summary { background: #f5f5f5; padding: 15px; margin: 20px 0; border-radius: 5px; }
                    .summary h3 { margin-top: 0; color: #333; }
                    .venda { border: 1px solid #ddd; margin: 10px 0; padding: 15px; border-radius: 5px; }
                    .venda-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
                    .venda-data { font-weight: bold; color: #333; }
                    .venda-total { font-weight: bold; color: #2196F3; font-size: 1.1em; }
                    .venda-itens { margin: 10px 0; }
                    .item { margin: 5px 0; padding: 5px; background: #f9f9f9; border-radius: 3px; }
                    .venda-info { display: flex; justify-content: space-between; margin-top: 10px; }
                    .lucro { color: #4CAF50; font-weight: bold; }
                    .pagamento { color: #666; }
                    @media print { body { margin: 0; } }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>📊 Histórico de Vendas - HidenSystems</h1>
                    <p>Relatório gerado em: ${dataAtual} às ${horaAtual}</p>
                    <p>Total de vendas: ${vendas.length}</p>
                    ${(() => {
                        if (fallbackPeriodo) {
                            return `<p>Período: Completo (fallback)</p>`;
                        }
                        if (dataInicio && dataFim) {
                            return `<p>Período: ${new Date(dataInicio).toLocaleDateString('pt-BR')} até ${new Date(dataFim).toLocaleDateString('pt-BR')}</p>`;
                        }
                        return `<p>Período: Completo</p>`;
                    })()}
                    ${(() => {
                        if (!vendedorFiltro || fallbackVendedor) return `<p>Vendedor: Todos${fallbackVendedor ? ' (fallback)' : ''}</p>`;
                        const encontrado = sistema.vendedores.find(v => String(v.id) === String(vendedorFiltro));
                        if (encontrado) return `<p>Vendedor: ${encontrado.nome}</p>`;
                        const sel = document.getElementById('vendedor-relatorio-select');
                        const label = sel?.selectedOptions?.[0]?.textContent || '';
                        const nomeOption = label.split(' — ')[0] || 'Selecionado';
                        return `<p>Vendedor: ${nomeOption}</p>`;
                    })()}
                </div>
        `;
        
        // Calcular resumo
        const totalVendas = vendas.reduce((sum, venda) => sum + (venda.totalVenda || 0), 0);
        const totalLucro = vendas.reduce((sum, venda) => sum + (venda.lucro || 0), 0);
        
        htmlContent += `
            <div class="summary">
                <h3>📈 Resumo Financeiro</h3>
                <p><strong>Total em Vendas:</strong> R$ ${totalVendas.toFixed(2).replace('.', ',')}</p>
                <p><strong>Total em Lucro:</strong> R$ ${totalLucro.toFixed(2).replace('.', ',')}</p>
                <p><strong>Margem de Lucro Média:</strong> ${((totalLucro / totalVendas) * 100).toFixed(1)}%</p>
            </div>
        `;
        
        // Adicionar cada venda
        vendas.forEach((venda, index) => {
            const dataVenda = new Date(venda.data).toLocaleDateString('pt-BR');
            const horaVenda = new Date(venda.data).toLocaleTimeString('pt-BR');
            
            htmlContent += `
                <div class="venda">
                    <div class="venda-header">
                        <span class="venda-data">🗓️ ${dataVenda} - ${horaVenda}</span>
                        <span class="venda-total">R$ ${(venda.totalVenda || 0).toFixed(2).replace('.', ',')}</span>
                    </div>
                    <div class="venda-itens">
                        <strong>📦 Itens:</strong>
            `;
            
            venda.itens.forEach(item => {
                htmlContent += `
                    <div class="item">
                        ${item.nome || 'Produto'} - Qtd: ${item.quantidade || 0} - R$ ${(item.precoUnitario || 0).toFixed(2).replace('.', ',')} cada
                    </div>
                `;
            });
            
            htmlContent += `
                    </div>
                    <div class="venda-info">
                        <span class="pagamento">💳 ${sistema.formatarFormaPagamento(venda.formaPagamento || 'Não informado')}</span>
                        <span class="lucro">💰 Lucro: R$ ${(venda.lucro || 0).toFixed(2).replace('.', ',')}</span>
                        ${venda.vendedor ? `<span class="vendedor">👤 Vendedor: ${venda.vendedor.nome}</span>` : ''}
                    </div>
                </div>
            `;
        });
        
        htmlContent += `
            </body>
            </html>
        `;
        
        // Abrir nova janela para impressão
        const printWindow = window.open('', '_blank');
        printWindow.document.write(htmlContent);
        printWindow.document.close();
        
        // Aguardar carregamento e imprimir
        printWindow.onload = function() {
            setTimeout(() => {
                printWindow.print();
            }, 500);
        };
        
        sistema.mostrarToast('Sucesso', 'PDF gerado! Use Ctrl+P para salvar como PDF.', 'success');
        
    } catch (error) {
        console.error('Erro ao gerar PDF:', error);
        sistema.mostrarToast('Erro', 'Erro ao gerar PDF do histórico!', 'error');
    }
}

// Fechar modal clicando fora dele
window.onclick = function(event) {
    const modal = document.getElementById('modal');
    if (event.target === modal) {
        modal.style.display = 'none';
    }
}

// Funções para dashboard executivo
function atualizarDashboardExecutivo() {
    const stats = sistema.obterEstatisticasGerais();
    const vendasPeriodo = sistema.obterVendasPorPeriodo(7);
    const produtosMaisVendidos = sistema.obterProdutosMaisVendidos(5);
    const formasPagamento = sistema.obterFormasPagamentoEstatisticas();
    
    // Atualizar cards de estatísticas
    document.getElementById('vendas-hoje-exec').textContent = `R$ ${stats.totalVendasHoje.toFixed(2).replace('.', ',')}`;
    document.getElementById('lucro-hoje-exec').textContent = `R$ ${stats.totalLucroHoje.toFixed(2).replace('.', ',')}`;
    document.getElementById('ticket-medio').textContent = `R$ ${stats.ticketMedio.toFixed(2).replace('.', ',')}`;
    document.getElementById('produtos-baixo-estoque').textContent = stats.produtosEstoqueBaixo;
    
    // Atualizar gráfico de vendas (simulado com texto)
    const graficoVendas = document.getElementById('grafico-vendas');
    if (graficoVendas) {
        let htmlGrafico = '<div class="grafico-simples">';
        vendasPeriodo.forEach(dia => {
            const altura = Math.max(10, (dia.vendas / Math.max(...vendasPeriodo.map(d => d.vendas))) * 100);
            htmlGrafico += `
                <div class="barra-grafico" style="height: ${altura}%" title="${dia.data}: R$ ${dia.vendas.toFixed(2)}">
                    <span class="data-grafico">${dia.data.split('/')[0]}/${dia.data.split('/')[1]}</span>
                </div>
            `;
        });
        htmlGrafico += '</div>';
        graficoVendas.innerHTML = htmlGrafico;
    }
    
    // Atualizar lista de produtos mais vendidos
    const listaProdutos = document.getElementById('produtos-mais-vendidos');
    if (listaProdutos) {
        let htmlProdutos = '';
        produtosMaisVendidos.forEach((produto, index) => {
            htmlProdutos += `
                <div class="produto-ranking">
                    <span class="ranking-posicao">${index + 1}º</span>
                    <span class="ranking-nome">${produto.nome}</span>
                    <span class="ranking-quantidade">${produto.quantidade} vendidos</span>
                    <span class="ranking-receita">R$ ${produto.receita.toFixed(2).replace('.', ',')}</span>
                </div>
            `;
        });
        listaProdutos.innerHTML = htmlProdutos || '<p>Nenhuma venda registrada</p>';
    }
}

// Event listeners para inicialização
document.addEventListener('DOMContentLoaded', function() {
    // Event listeners para formulário de produtos
    const produtoForm = document.getElementById('produto-form');
    if (produtoForm) {
        produtoForm.addEventListener('submit', function(e) {
            e.preventDefault();
            sistema.adicionarProduto();
        });
        
        // Event listeners para cálculo de margem
        const custoInput = document.getElementById('custo-produto');
        const precoInput = document.getElementById('preco-produto');
        
        if (custoInput) custoInput.addEventListener('input', () => sistema.calcularMargemLucro());
        if (precoInput) precoInput.addEventListener('input', () => sistema.calcularMargemLucro());
    }
    
    // Event listener para busca de produtos
    const searchInput = document.getElementById('search-produtos');
    if (searchInput) {
        searchInput.addEventListener('input', buscarProdutos);
    }
    
    // Event listener para busca do bloco "Buscar Produtos"
    const buscarInput = document.getElementById('buscar-produto');
    if (buscarInput) {
        buscarInput.addEventListener('input', buscarProdutosPorNome);
    }

    // Listeners reativos para filtros de Relatórios
    const vendedorRelSelect = document.getElementById('vendedor-relatorio-select');
    const dataInicioEl = document.getElementById('data-inicio');
    const dataFimEl = document.getElementById('data-fim');
    const aplicarFiltroSeguro = () => {
        const di = dataInicioEl?.value;
        const df = dataFimEl?.value;
        if (di && df && new Date(di) <= new Date(df)) {
            filtrarRelatorio();
        } else {
            sistema.atualizarRelatorios();
        }
    };
    if (vendedorRelSelect) vendedorRelSelect.addEventListener('change', aplicarFiltroSeguro);
    if (dataInicioEl) dataInicioEl.addEventListener('change', aplicarFiltroSeguro);
    if (dataFimEl) dataFimEl.addEventListener('change', aplicarFiltroSeguro);
});

// ===== FUNÇÃO SHOWTAB - MOVER PARA AQUI =====
function showTab(tabName) {
    console.log(`🔄 Mudando para a página: ${tabName.toUpperCase()}`);
    
    try {
        // 1. Ocultar todas as abas
        const allTabs = document.querySelectorAll('.tab-content');
        const allButtons = document.querySelectorAll('.tab-btn');
        
        allTabs.forEach(tab => {
            tab.classList.remove('active');
        });
        
        // 2. Remover classe active de todos os botões
        allButtons.forEach(btn => btn.classList.remove('active'));
        
        // 3. Mostrar aba selecionada
        const targetTab = document.getElementById(tabName);
        const targetButton = document.querySelector(`[onclick="showTab('${tabName}')"]`);
        
        if (targetTab && targetButton) {
            targetTab.classList.add('active');
            targetButton.classList.add('active');
            
            console.log(`✅ Aba ${tabName} ativada com sucesso`);
            
            // 4. Carregar conteúdo específico da página (sem timeout para evitar problemas)
            if (typeof sistema !== 'undefined') {
                switch(tabName) {
                    case 'caixa':
                        console.log('💰 Carregando Página do Caixa...');
                        sistema.atualizarCarrinho();
                        sistema.carregarProdutosSelect();
                        if (typeof atualizarEstatisticas === 'function') {
                            atualizarEstatisticas();
                        }
                        break;
                        
                    case 'estoque':
                        console.log('📦 Carregando Página do Estoque...');
                        sistema.atualizarEstoque();
                        sistema.atualizarEstatisticasEstoque();
                        // Inicializar gráficos e movimentações do Estoque
                        if (typeof sistema.inicializarAnaliseEstoque === 'function') {
                            sistema.inicializarAnaliseEstoque();
                        }
                        if (typeof sistema.renderizarMovimentacoesRecentes === 'function') {
                            sistema.renderizarMovimentacoesRecentes();
                        }
                        if (typeof sistema.atualizarRotatividadeEstoque === 'function') {
                            sistema.atualizarRotatividadeEstoque();
                        }
                        if (typeof sistema.aplicarFiltrosCombinados === 'function') {
                            sistema.aplicarFiltrosCombinados('estoque-lista');
                        }
                        break;
                        
                    case 'produtos':
                        console.log('🛍️ Carregando Página de Produtos...');
                        sistema.exibirProdutosFiltrados();
                        sistema.atualizarEstatisticasProdutos();
                        break;
                        
                    case 'relatorios':
                        console.log('📊 Carregando Página de Relatórios...');
                        sistema.atualizarRelatorios();
                        sistema.inicializarDatasRelatorio();
                        break;
                }
                console.log(`✨ Página ${tabName.toUpperCase()} carregada!`);
            } else {
                console.warn('⚠️ Sistema ainda não inicializado');
            }
            
        } else {
            console.error(`❌ Elementos não encontrados para a aba: ${tabName}`);
            console.log('Aba encontrada:', !!targetTab);
            console.log('Botão encontrado:', !!targetButton);
        }
        
    } catch (error) {
        console.error(`💥 Erro ao carregar página ${tabName}:`, error);
    }
}

// Inicializar sistema
const sistema = new SistemaTabacaria();

// Configurar chave PIX fornecida pelo usuário
sistema.definirPixChave('165.940.097-02');

// Configurar nome e cidade do recebedor PIX
sistema.definirPixRecebedor('', '');

// Teste das notificações após carregamento
setTimeout(() => {
    console.log('Testando notificações...');
    atualizarEstatisticas();
    sistema.mostrarToast('Sistema', 'Aplicação carregada com sucesso!', 'success');
}, 1000);

// Atualizar dashboard executivo quando a aba for mostrada

// ===== Recursos avançados da aba Estoque (protótipos) =====
// Gráficos e análises rápidas
SistemaTabacaria.prototype.inicializarAnaliseEstoque = function() {
    try {
        const produtos = this.produtos || [];
        const categorias = {};
        produtos.forEach(p => {
            const cat = (p.categoria || 'Outros');
            categorias[cat] = (categorias[cat] || 0) + (p.estoque || 0);
        });
        const catLabels = Object.keys(categorias);
        const catData = Object.values(categorias);

        let ok = 0, baixo = 0, zero = 0;
        produtos.forEach(p => {
            const minimo = (Number.isFinite(p.minimo) && p.minimo > 0) ? p.minimo : 5;
            if ((p.estoque || 0) === 0) zero++;
            else if ((p.estoque || 0) <= minimo) baixo++;
            else ok++;
        });

        const valorCategorias = {};
        produtos.forEach(p => {
            const cat = (p.categoria || 'Outros');
            const valor = (p.preco || 0) * (p.estoque || 0);
            valorCategorias[cat] = (valorCategorias[cat] || 0) + valor;
        });
        const valorLabels = Object.keys(valorCategorias);
        const valorData = Object.values(valorCategorias);

        const ctxCat = document.getElementById('grafico-estoque-categorias');
        const ctxStatus = document.getElementById('grafico-estoque-status');
        const ctxValor = document.getElementById('grafico-estoque-valor');
        if (ctxCat && typeof Chart !== 'undefined') {
            if (this._chartEstoqueCategorias) this._chartEstoqueCategorias.destroy();
            this._chartEstoqueCategorias = new Chart(ctxCat, {
                type: 'doughnut',
                data: { labels: catLabels, datasets: [{ data: catData, backgroundColor: ['#3b82f6','#22c55e','#f59e0b','#ef4444','#8b5cf6','#06b6d4'] }] },
                options: { plugins: { legend: { position: 'bottom' } } }
            });
        }
        if (ctxStatus && typeof Chart !== 'undefined') {
            if (this._chartEstoqueStatus) this._chartEstoqueStatus.destroy();
            this._chartEstoqueStatus = new Chart(ctxStatus, {
                type: 'bar',
                data: { labels: ['OK','Baixo','Zerado'], datasets: [{ data: [ok, baixo, zero], backgroundColor: ['#22c55e','#f59e0b','#ef4444'] }] },
                options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
            });
        }
        if (ctxValor && typeof Chart !== 'undefined') {
            if (this._chartEstoqueValor) this._chartEstoqueValor.destroy();
            this._chartEstoqueValor = new Chart(ctxValor, {
                type: 'pie',
                data: { labels: valorLabels, datasets: [{ data: valorData, backgroundColor: ['#0ea5e9','#10b981','#f59e0b','#ef4444','#a78bfa','#14b8a6'] }] },
                options: { plugins: { legend: { position: 'bottom' } } }
            });
        }
    } catch (e) {
        console.warn('Falha ao inicializar análises de estoque:', e);
    }
};

// Movimentações recentes
SistemaTabacaria.prototype.renderizarMovimentacoesRecentes = function() {
    const ul = document.getElementById('mov-list');
    if (!ul) return;
    const movimentos = this.obterMovimentosEstoque ? this.obterMovimentosEstoque() : [];
    const seteDiasAtras = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const recentes = movimentos.filter(m => new Date(m.data).getTime() >= seteDiasAtras).sort((a,b) => new Date(b.data) - new Date(a.data));
    this._coalesce.renderRaf = this._coalesce.renderRaf || {};
    try { cancelAnimationFrame(this._coalesce.renderRaf['mov-list']); } catch (_) {}
    this._coalesce.renderRaf['mov-list'] = requestAnimationFrame(() => {
        if (recentes.length === 0) {
            ul.innerHTML = '<li class="mov-empty">Sem movimentações nos últimos 7 dias</li>';
            return;
        }
        ul.innerHTML = recentes.slice(0, 10).map(m => {
            const tipoIcon = m.tipo === 'entrada' ? '⬆️' : m.tipo === 'saida' ? '⬇️' : '⚙️';
            const dataLocal = new Date(m.data).toLocaleString();
            return `<li><strong>${tipoIcon} ${m.tipo.toUpperCase()}</strong> • ${m.nome || m.codigo || 'Produto'} • ${m.quantidade} un • <span style="color:#6b7280">${dataLocal}</span></li>`;
        }).join('');
    });
};

// Painel de movimentos: entrada, saída, ajuste
SistemaTabacaria.prototype.abrirPainelMovimento = function(tipo) {
    const titulo = tipo === 'entrada' ? 'Registrar Entrada' : tipo === 'saida' ? 'Registrar Saída' : 'Ajuste de Estoque';
    const body = `
        <div class="ajuste-modal">
            <div id="ajuste-summary" class="ajuste-summary">
                <div class="summary-grid">
                    <div>
                        <div class="summary-label">Produto</div>
                        <div class="summary-value" id="mov-produto-nome">—</div>
                    </div>
                    <div>
                        <div class="summary-label">Estoque atual</div>
                        <div class="summary-value" id="mov-estoque-atual">0</div>
                    </div>
                    <div>
                        <div class="summary-label">Mínimo</div>
                        <div class="summary-value" id="mov-minimo">0</div>
                    </div>
                    <div>
                        <div class="summary-label">Status</div>
                        <div class="summary-value"><span id="mov-status-badge" class="status-badge">—</span></div>
                    </div>
                </div>
            </div>
            <div class="segmented" role="tablist" aria-label="Tipo de movimento">
                <label class="segmented-item">
                    <input type="radio" name="mov-tipo" value="entrada" ${tipo === 'entrada' ? 'checked' : ''}>
                    <span>Entrada</span>
                </label>
                <label class="segmented-item">
                    <input type="radio" name="mov-tipo" value="saida" ${tipo === 'saida' ? 'checked' : ''}>
                    <span>Saída</span>
                </label>
                <label class="segmented-item">
                    <input type="radio" name="mov-tipo" value="ajuste" ${tipo === 'ajuste' ? 'checked' : (!['entrada','saida'].includes(tipo) ? 'checked' : '')}>
                    <span>Ajuste</span>
                </label>
            </div>

            <div class="form-grid">
                <div class="field">
                    <label>Produto</label>
                    <select id="mov-produto">
                        ${ (this.produtos || []).map(p => `<option value="${p.id}">${p.nome} (${p.estoque || 0} un)</option>`).join('') }
                    </select>
                </div>
                <div class="field">
                    <label id="label-quantidade">Quantidade</label>
                    <div class="quantity-input">
                        <button type="button" aria-label="Diminuir" onclick="adjustFormQuantity('mov-quantidade', -1)">-</button>
                        <input type="number" id="mov-quantidade" min="1" value="1" required>
                        <button type="button" aria-label="Aumentar" onclick="adjustFormQuantity('mov-quantidade', 1)">+</button>
                    </div>
                </div>
                <div class="field">
                    <label>Motivo</label>
                    <select id="mov-motivo">
                        <option value="">Selecione…</option>
                        <option value="compra">Compra de fornecedor</option>
                        <option value="devolucao">Devolução de cliente</option>
                        <option value="avaria">Avaria / Perda</option>
                        <option value="inventario">Inventário / Correção</option>
                        <option value="transferencia">Transferência</option>
                    </select>
                </div>
                <div class="field full">
                    <label>Observação</label>
                    <input type="text" id="mov-obs" placeholder="Fornecedor, nota, lote, motivo...">
                </div>
                <div class="field">
                    <label>Data</label>
                    <input type="datetime-local" id="mov-data">
                </div>
                <div class="field full">
                    <div id="mov-preview" class="preview-box">
                        <div>Estoque atual: <strong id="prev-atual">0</strong></div>
                        <div>Após movimento: <strong id="prev-depois">0</strong></div>
                        <div>Diferença: <strong id="prev-diff">0</strong></div>
                    </div>
                    <div id="mov-validation" class="validation-msg"></div>
                </div>
            </div>

            <div class="modal-actions">
                <button class="acao-btn ghost" onclick="fecharModal()">Cancelar</button>
                <button class="acao-btn ajuste" id="mov-confirm-btn" onclick="sistema.confirmarMovimento()" disabled>Confirmar</button>
            </div>
        </div>`;
    this.mostrarModal(titulo, body, 'info');
    const dt = document.getElementById('mov-data');
    if (dt) {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        dt.value = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    // Inicializa preview e listeners
    const atualizar = () => this._atualizarPreviewMovimento();
    ['change','input'].forEach(ev => {
        const qtd = document.getElementById('mov-quantidade');
        const prod = document.getElementById('mov-produto');
        if (qtd) qtd.addEventListener(ev, atualizar);
        if (prod) prod.addEventListener(ev, atualizar);
        document.querySelectorAll('input[name="mov-tipo"]').forEach(r => r.addEventListener(ev, atualizar));
    });
    this._atualizarPreviewMovimento();
};

SistemaTabacaria.prototype.confirmarMovimento = function(tipo) {
    // Permite trocar o tipo dentro do modal via segmented control
    const tipoSelecionado = tipo || (document.querySelector('input[name="mov-tipo"]:checked')?.value || 'ajuste');
    const produtoId = parseInt(document.getElementById('mov-produto').value);
    const quantidade = parseInt(document.getElementById('mov-quantidade').value);
    const obs = document.getElementById('mov-obs').value || '';
    const motivo = document.getElementById('mov-motivo')?.value || '';
    const dataStr = document.getElementById('mov-data').value;
    const produto = this.getProdutoById(produtoId);
    if (!produto || !Number.isFinite(quantidade) || quantidade <= 0) {
        this.mostrarModal('Erro', 'Selecione um produto e quantidade válida.', 'error');
        return;
    }
    const estoqueAntes = produto.estoque || 0;
    let novoEstoque = estoqueAntes;
    if (tipoSelecionado === 'entrada') novoEstoque += quantidade;
    else if (tipoSelecionado === 'saida') novoEstoque = Math.max(0, novoEstoque - quantidade);
    else if (tipoSelecionado === 'ajuste') novoEstoque = quantidade; // ajuste define valor absoluto

    // Validações de saída e ajuste
    if (tipoSelecionado === 'saida' && quantidade > estoqueAntes) {
        this.mostrarModal('Erro', 'Quantidade de saída excede o estoque atual.', 'error');
        return;
    }
    if (tipoSelecionado === 'ajuste' && novoEstoque < 0) {
        this.mostrarModal('Erro', 'Ajuste não pode resultar em estoque negativo.', 'error');
        return;
    }

    const movimento = {
        id: 'M' + Date.now() + '-' + produto.id,
        data: dataStr ? new Date(dataStr).toISOString() : new Date().toISOString(),
        tipo: tipoSelecionado,
        origem: tipoSelecionado,
        produtoId: produto.id,
        nome: produto.nome,
        codigo: produto.codigo || '',
        categoria: produto.categoria || 'outros',
        fornecedor: produto.fornecedor || '',
        quantidade: tipoSelecionado === 'ajuste' ? Math.abs(novoEstoque - estoqueAntes) : quantidade,
        estoqueAntes,
        estoqueDepois: novoEstoque,
        observacao: obs,
        motivo
    };
    // Persistir
    this.registrarMovimentoEstoque(movimento);
    produto.estoque = novoEstoque;
    this.salvarProdutos();
    // Atualizar interface e análises
    this.atualizarEstoque();
    this.atualizarEstatisticasEstoque();
    if (typeof this.inicializarAnaliseEstoque === 'function') this.inicializarAnaliseEstoque();
    if (typeof this.renderizarMovimentacoesRecentes === 'function') this.renderizarMovimentacoesRecentes();
    if (typeof this.atualizarRotatividadeEstoque === 'function') this.atualizarRotatividadeEstoque();
    if (typeof this.aplicarFiltrosCombinados === 'function') this.aplicarFiltrosCombinados('estoque-lista');
    // Avisos de baixo estoque/zerado
    const minimo = (Number.isFinite(produto.minimo) && produto.minimo > 0) ? produto.minimo : 5;
    if (novoEstoque === 0) this.mostrarToast('Produto ficou sem estoque.', 'warning');
    else if (novoEstoque > 0 && novoEstoque <= minimo) this.mostrarToast('Produto com estoque baixo.', 'warning');
    this.mostrarToast('Movimentação registrada com sucesso!', 'success');
    // Fechar modal
    const modal = document.getElementById('modal');
    if (modal) modal.style.display = 'none';
};

// Atualiza preview do movimento no modal em tempo real
SistemaTabacaria.prototype._atualizarPreviewMovimento = function() {
    const produtoId = parseInt(document.getElementById('mov-produto')?.value);
    const quantidade = parseInt(document.getElementById('mov-quantidade')?.value || '0');
    const tipoSelecionado = (document.querySelector('input[name="mov-tipo"]:checked')?.value) || 'ajuste';
    const produto = this.getProdutoById(produtoId);
    const nomeEl = document.getElementById('mov-produto-nome');
    const atualEl = document.getElementById('mov-estoque-atual');
    const minEl = document.getElementById('mov-minimo');
    const badgeEl = document.getElementById('mov-status-badge');
    const prevAtual = document.getElementById('prev-atual');
    const prevDepois = document.getElementById('prev-depois');
    const prevDiff = document.getElementById('prev-diff');
    const validationEl = document.getElementById('mov-validation');
    const confirmBtn = document.getElementById('mov-confirm-btn');
    const labelQtd = document.getElementById('label-quantidade');

    if (!produto) {
        if (confirmBtn) confirmBtn.disabled = true;
        return;
    }
    const estoqueAtual = produto.estoque || 0;
    const minimo = (Number.isFinite(produto.minimo) && produto.minimo > 0) ? produto.minimo : 5;
    let estoqueDepois = estoqueAtual;
    if (tipoSelecionado === 'entrada') estoqueDepois += quantidade;
    else if (tipoSelecionado === 'saida') estoqueDepois = Math.max(0, estoqueAtual - (Number.isFinite(quantidade) ? quantidade : 0));
    else if (tipoSelecionado === 'ajuste') estoqueDepois = Number.isFinite(quantidade) ? quantidade : estoqueAtual;
    const diff = estoqueDepois - estoqueAtual;

    // Atualiza textos
    if (nomeEl) nomeEl.textContent = produto.nome;
    if (atualEl) atualEl.textContent = `${estoqueAtual}`;
    if (minEl) minEl.textContent = `${minimo}`;
    if (prevAtual) prevAtual.textContent = `${estoqueAtual}`;
    if (prevDepois) prevDepois.textContent = `${estoqueDepois}`;
    if (prevDiff) prevDiff.textContent = `${diff > 0 ? '+' : ''}${diff}`;
    if (labelQtd) labelQtd.textContent = tipoSelecionado === 'ajuste' ? 'Nova quantidade' : 'Quantidade';

    // Badge de status
    if (badgeEl) {
        const status = estoqueAtual === 0 ? 'sem-estoque' : estoqueAtual <= minimo ? 'estoque-baixo' : 'estoque-ok';
        badgeEl.className = `status-badge ${status}`;
        badgeEl.textContent = estoqueAtual === 0 ? 'SEM ESTOQUE' : estoqueAtual <= minimo ? 'ESTOQUE BAIXO' : 'ESTOQUE OK';
    }

    // Validações
    let erro = '';
    let aviso = '';
    if (tipoSelecionado === 'saida' && quantidade > estoqueAtual) {
        erro = 'Quantidade de saída excede o estoque atual.';
    }
    if (tipoSelecionado === 'ajuste' && estoqueDepois < 0) {
        erro = 'Ajuste não pode resultar em estoque negativo.';
    }
    if (!erro) {
        if (estoqueDepois === 0) aviso = 'Produto ficará sem estoque.';
        else if (estoqueDepois > 0 && estoqueDepois <= minimo) aviso = 'Produto ficará com estoque baixo.';
    }

    if (validationEl) {
        validationEl.textContent = erro || aviso;
        validationEl.className = `validation-msg ${erro ? 'error' : aviso ? 'warning' : ''}`;
    }
    if (confirmBtn) confirmBtn.disabled = !!erro || !Number.isFinite(quantidade) || quantidade <= 0;
};

// Rotatividade de estoque (30 dias)
SistemaTabacaria.prototype.atualizarRotatividadeEstoque = function() {
    try {
        const el = document.getElementById('rotatividade-estoque');
        if (!el) return;
        const movimentos = this.obterMovimentosEstoque ? this.obterMovimentosEstoque() : [];
        const trintaDias = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const saidas30d = movimentos.filter(m => m.tipo === 'saida' && new Date(m.data).getTime() >= trintaDias)
                                    .reduce((acc, m) => acc + (m.quantidade || 0), 0);
        const totalUnidades = (this.produtos || []).reduce((acc, p) => acc + (p.estoque || 0), 0);
        const turnover = totalUnidades > 0 ? Math.min(100, Math.round((saidas30d / totalUnidades) * 100)) : 0;
        el.textContent = `${turnover}%`;
    } catch (e) {
        console.warn('Falha ao atualizar rotatividade de estoque:', e);
    }
};

// Ajuste de quantidade (compatível com função global)
SistemaTabacaria.prototype.adjustFormQuantity = function(inputId, change) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const min = parseInt(el.min || '0');
    const atual = parseInt(el.value || '0');
    const novo = Math.max(min, atual + change);
    el.value = isNaN(novo) ? 0 : novo;
};

// Função para abrir modal de ajuste de estoque
function abrirModalEstoque(id) {
    const produto = sistema.getProdutoById(id);
    if (!produto) return;
    
    const quantidade = prompt(`Ajustar estoque de "${produto.nome}"\nEstoque atual: ${produto.estoque} unidades\n\nDigite a nova quantidade:`, produto.estoque);
    
    if (quantidade !== null && quantidade !== '') {
        const novaQuantidade = parseInt(quantidade);
        if (!isNaN(novaQuantidade) && novaQuantidade >= 0) {
            const delta = novaQuantidade - (produto.estoque || 0);
            if (delta !== 0) {
                sistema.ajustarEstoque(produto.id, delta);
                sistema.exibirProdutosFiltrados();
            } else {
                sistema.mostrarToast('Nenhuma alteração de estoque realizada.', 'warning');
            }
        } else {
            sistema.mostrarModal('Erro', 'Por favor, digite um número válido maior ou igual a zero.', 'error');
        }
    }
}

// Função global para ajustar estoque (compatibilidade)
function ajustarEstoque(id, quantidade) {
    sistema.ajustarEstoque(id, quantidade);
}

// Função global para ajustar quantidade em formulários (compatibilidade)
function adjustFormQuantity(inputId, change) {
    sistema.adjustFormQuantity(inputId, change);
}



// Inicializar página padrão
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(() => {
        showTab('caixa'); // Página inicial
    }, 500);
});
