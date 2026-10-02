// Disable F12 & Inspect Element
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
    if (e.key === 'F12') { e.preventDefault(); e.stopPropagation(); }
    if (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'K', 'i', 'j', 'c', 'k'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
    if (e.ctrlKey && ['U', 'u', 'S', 's'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
});

document.addEventListener('DOMContentLoaded', () => {

    /* ── Elements ── */
    const tabBtns       = document.querySelectorAll('.tab-btn');

    const stepInput     = document.getElementById('step-input');
    const stepDevice    = document.getElementById('step-device');
    const stepPhoneRes  = document.getElementById('step-phone-result');
    const stepTVCode    = document.getElementById('step-tv-code');
    const stepTVOk      = document.getElementById('step-tv-success');
    const stepLoading   = document.getElementById('step-loading');
    const loaderText    = document.getElementById('loader-text');
    const backBtn       = document.getElementById('back-btn');

    const cdkInput      = document.getElementById('cdk-input');
    const pasteBtn      = document.getElementById('paste-btn');
    const verifyBtn     = document.getElementById('verify-btn');
    const planPill      = document.getElementById('plan-pill');

    const btnPhone      = document.getElementById('btn-phone');
    const btnPC         = document.getElementById('btn-pc');
    const btnTV         = document.getElementById('btn-tv');

    const copyLinkBtn   = document.getElementById('copy-link-btn');
    const openLinkBtn   = document.getElementById('open-link-btn');
    const copyBtnLabel  = document.getElementById('copy-btn-label');
    const burnNotice    = document.getElementById('burn-notice');

    const pinBoxes      = Array.from(document.querySelectorAll('.pin-box'));
    const tvActivateBtn = document.getElementById('tv-activate-btn');

    const tcdValue      = document.getElementById('tcd-value');
    const reopenLink    = document.getElementById('reopen-link');

    const bulkInput     = document.getElementById('bulk-input');
    const bulkBtn       = document.getElementById('bulk-btn');
    const bulkResults   = document.getElementById('bulk-results');
    const bulkSummary   = document.getElementById('bulk-summary');
    const bulkTbody     = document.getElementById('bulk-tbody');

    const toast         = document.getElementById('toast');
    const systemStatus  = document.getElementById('system-status');
    const btnAPIDocs    = document.getElementById('btn-api-docs');
    const apiModal      = document.getElementById('api-modal');
    const apiModalClose = document.getElementById('api-modal-close');

    /* ── State ── */
    let currentKey = '';
    let pendingLoginUrl = '';
    let pendingTvUrl    = '';

    // Check system status (active cookies available)
    async function checkSystemStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            systemStatus.className = 'status-indicator ' + data.status.toLowerCase();
            systemStatus.querySelector('.status-text').textContent = data.status;
        } catch (_) {
            systemStatus.className = 'status-indicator maintenance';
            systemStatus.querySelector('.status-text').textContent = 'OFFLINE';
        }
    }
    checkSystemStatus();

    // API Docs Modal Event Listeners
    if (btnAPIDocs && apiModal) {
        btnAPIDocs.addEventListener('click', () => {
            apiModal.classList.remove('hidden');
        });
    }
    if (apiModalClose && apiModal) {
        apiModalClose.addEventListener('click', () => {
            apiModal.classList.add('hidden');
        });
    }
    if (apiModal) {
        apiModal.addEventListener('click', (e) => {
            if (e.target === apiModal) apiModal.classList.add('hidden');
        });
    }

    /* ═══════ UTILITIES ═══════ */
    function showToast(msg, type = 'success') {
        toast.textContent = msg;
        toast.className   = `toast ${type}`;
        toast.classList.remove('hidden');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toast.classList.add('hidden'), 3600);
    }

    function setLoading(btn, loading) {
        btn.disabled = loading;
        btn.querySelector('.btn-spinner').classList.toggle('hidden', !loading);
        btn.querySelector('.btn-icon').classList.toggle('hidden', loading);
        btn.querySelector('.btn-label').classList.toggle('hidden', loading);
    }

    function copyText(text) {
        try { navigator.clipboard.writeText(text); }
        catch (_) {
            const el = document.createElement('input');
            el.value = text; document.body.appendChild(el);
            el.select(); document.execCommand('copy');
            document.body.removeChild(el);
        }
    }

    function hideAll() {
        [stepDevice, stepPhoneRes, stepTVCode, stepTVOk, stepLoading].forEach(el => el.classList.add('hidden'));
        backBtn.classList.add('hidden');
        burnNotice.classList.add('hidden');
        pendingLoginUrl = '';
        pendingTvUrl    = '';
    }

    /* ═══════ TABS ═══════ */
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            const cardEl = document.getElementById('main-card');
            if (btn.dataset.tab === 'verify') {
                cardEl.classList.add('wide');
            } else {
                cardEl.classList.remove('wide');
            }

            document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
            document.getElementById('panel-' + btn.dataset.tab).classList.remove('hidden');
        });
    });

    /* ═══════ PASTE ═══════ */
    pasteBtn.addEventListener('click', async () => {
        try {
            const t = await navigator.clipboard.readText();
            if (t) { cdkInput.value = t.trim().toUpperCase(); showToast('Pasted'); }
        } catch (_) { cdkInput.focus(); showToast('Paste manually', 'error'); }
    });

    /* ═══════ STEP 1 — VERIFY ═══════ */
    verifyBtn.addEventListener('click', doVerify);
    cdkInput.addEventListener('keydown', e => { if (e.key === 'Enter') doVerify(); });

    async function doVerify() {
        const key = cdkInput.value.trim().toUpperCase();
        if (!key) { showToast('Enter your CDK code', 'error'); return; }
        currentKey = key;
        hideAll();

        setLoading(verifyBtn, true);
        try {
            const res  = await fetch('/api/check-cdk', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ key })
            });
            const data = await res.json();

            if (!res.ok || !data.valid) {
                showToast(data.error || 'Invalid or expired code', 'error');
                return;
            }

            if (!data.available) {
                showToast('All slots occupied. Contact support.', 'error');
                return;
            }

            let label = data.planType || 'Premium';
            if (label.toLowerCase() === 'premium') {
                label = 'Premium 4K';
            } else if (label.toLowerCase() === 'standard') {
                label = 'Standard 1080p';
            } else if (label.toLowerCase() === 'basic') {
                label = 'Basic 1080p';
            } else if (label.toLowerCase() === 'tv') {
                label = 'TV Screen Activation';
            }

            planPill.textContent = label;
            
            // Device choice rules: TV CDK works only on TV; All other CDKs work on ALL devices (Phone, PC, TV)
            const isTVPlan = (data.planType || '').toLowerCase() === 'tv';
            if (isTVPlan) {
                btnPhone.classList.add('disabled');
                btnPhone.setAttribute('disabled', 'true');
                btnPC.classList.add('disabled');
                btnPC.setAttribute('disabled', 'true');
                
                btnTV.classList.remove('disabled');
                btnTV.removeAttribute('disabled');
            } else {
                // All other CDKs work on all 3 devices — user chooses freely
                btnPhone.classList.remove('disabled');
                btnPhone.removeAttribute('disabled');
                btnPC.classList.remove('disabled');
                btnPC.removeAttribute('disabled');
                btnTV.classList.remove('disabled');
                btnTV.removeAttribute('disabled');
            }

            stepInput.classList.add('hidden'); // Hide Step 1 completely
            stepDevice.classList.remove('hidden'); // Show Step 2 Device Selector
            backBtn.classList.remove('hidden');
            showToast('Code verified. Choose your device.', 'success');

        } catch (_) {
            showToast('Connection error', 'error');
        } finally {
            setLoading(verifyBtn, false);
        }
    }

    /* ═══════ STEP 2 — DEVICE CHOICE ═══════ */
    let selectedDevice = null; // 'phone' | 'pc' | 'tv'

    const confirmBar     = document.getElementById('device-confirm-bar');
    const confirmDevBtn  = document.getElementById('device-confirm-btn');
    const cancelDevBtn   = document.getElementById('device-cancel-btn');
    const confirmDevLabel = document.getElementById('device-confirm-label');

    function selectDevice(device, btn) {
        selectedDevice = device;
        // Remove selected from all
        [btnPhone, btnPC, btnTV].forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        // Update confirm label
        const labels = { phone: 'Phone / Tablet', pc: 'PC / Laptop', tv: 'Smart TV' };
        confirmDevLabel.textContent = `Confirm: ${labels[device]}`;
        confirmBar.classList.remove('hidden');
    }

    btnPhone.addEventListener('click', () => selectDevice('phone', btnPhone));
    btnPC.addEventListener('click',    () => selectDevice('pc',    btnPC));
    btnTV.addEventListener('click',    () => selectDevice('tv',    btnTV));

    cancelDevBtn.addEventListener('click', () => {
        selectedDevice = null;
        [btnPhone, btnPC, btnTV].forEach(b => b.classList.remove('selected'));
        confirmBar.classList.add('hidden');
    });

    confirmDevBtn.addEventListener('click', async () => {
        if (!selectedDevice) return;
        confirmBar.classList.add('hidden');
        [btnPhone, btnPC, btnTV].forEach(b => b.classList.remove('selected'));
        if (selectedDevice === 'tv') {
            stepDevice.classList.add('hidden');
            stepTVCode.classList.remove('hidden');
            pinBoxes.forEach(b => b.value = '');
            tvActivateBtn.classList.add('hidden'); // hide until code filled
            if (pinBoxes[0]) pinBoxes[0].focus();
        } else {
            stepDevice.classList.add('hidden');
            await getLink(selectedDevice);
        }
        selectedDevice = null;
    });

    /* ═══════ STEP 3A — PHONE / PC LINK ═══════ */
    async function getLink(deviceType) {
        verifyBtn.disabled = true;
        stepDevice.classList.add('hidden');
        stepLoading.classList.remove('hidden');
        loaderText.textContent = 'Verifying and generating secure login link...';
        
        try {
            const res  = await fetch('/api/redeem', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ key: currentKey, deviceType })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                showToast(data.error || 'Activation failed. Try again.', 'error');
                stepLoading.classList.add('hidden');
                stepDevice.classList.remove('hidden');
                return;
            }

            pendingLoginUrl = data.loginUrl;
            pendingTvUrl    = data.tvUrl;
            
            if (openLinkBtn) {
                openLinkBtn.href = pendingLoginUrl;
                openLinkBtn.style.pointerEvents = 'auto';
                openLinkBtn.style.opacity = '1';
            }
            
            copyBtnLabel.textContent = 'Copy Login Link';
            copyLinkBtn.disabled = false;
            burnNotice.classList.add('hidden');
            
            stepLoading.classList.add('hidden');
            stepPhoneRes.classList.remove('hidden');

        } catch (_) {
            showToast('Connection error', 'error');
            stepLoading.classList.add('hidden');
            stepDevice.classList.remove('hidden');
        } finally {
            verifyBtn.disabled = false;
        }
    }

    async function burnKey() {
        try {
            await fetch('/api/burn-cdk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: currentKey })
            });
        } catch (_) {}
    }

    copyLinkBtn.addEventListener('click', async () => {
        if (!pendingLoginUrl) return;
        copyText(pendingLoginUrl);
        showToast('Link copied!', 'success');

        copyBtnLabel.textContent = 'Link Copied';
        copyLinkBtn.disabled = true;
        if (openLinkBtn) {
            openLinkBtn.style.pointerEvents = 'none';
            openLinkBtn.style.opacity = '0.5';
        }
        burnNotice.classList.remove('hidden');
        await burnKey();
    });

    if (openLinkBtn) {
        openLinkBtn.addEventListener('click', async () => {
            // Disable actions immediately
            copyLinkBtn.disabled = true;
            openLinkBtn.style.pointerEvents = 'none';
            openLinkBtn.style.opacity = '0.5';
            burnNotice.classList.remove('hidden');
            await burnKey();
        });
    }

    /* ═══════ STEP 3B — TV CODE (8-PIN BOXES) ═══════ */
    function checkTVCodeFilled() {
        const code = getTVCode();
        if (code.length === 8) {
            tvActivateBtn.classList.remove('hidden');
        } else {
            tvActivateBtn.classList.add('hidden');
        }
    }

    pinBoxes.forEach((box, index) => {
        box.addEventListener('input', () => {
            const val = box.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            box.value = val;
            if (val && index < pinBoxes.length - 1) {
                pinBoxes[index + 1].focus();
            }
            checkTVCodeFilled();
        });

        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !box.value && index > 0) {
                pinBoxes[index - 1].focus();
                setTimeout(checkTVCodeFilled, 0);
            } else if (e.key === 'Enter' && getTVCode().length === 8) {
                doTVActivate();
            }
        });

        box.addEventListener('paste', (e) => {
            e.preventDefault();
            const pasted = (e.clipboardData || window.clipboardData).getData('text').toUpperCase().replace(/[^A-Z0-9]/g, '');
            for (let i = 0; i < pinBoxes.length; i++) {
                pinBoxes[i].value = pasted[i] || '';
            }
            const nextFocusIndex = Math.min(pasted.length, pinBoxes.length - 1);
            pinBoxes[nextFocusIndex].focus();
            checkTVCodeFilled();
        });
    });

    function getTVCode() {
        return pinBoxes.map(b => b.value.trim()).join('');
    }

    tvActivateBtn.addEventListener('click', doTVActivate);

    async function doTVActivate() {
        const tvCode = getTVCode();
        if (tvCode.length < 8) {
            showToast('Please enter all 8 digits of your TV code', 'error');
            const firstEmpty = pinBoxes.find(b => !b.value.trim()) || pinBoxes[0];
            firstEmpty.focus();
            return;
        }

        stepTVCode.classList.add('hidden');
        stepLoading.classList.remove('hidden');
        loaderText.textContent = 'Activating your TV Screen...';

        try {
            const res  = await fetch('/api/redeem', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ key: currentKey, tvCode })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                showToast(data.error || 'Activation failed. Please check TV code and try again.', 'error');
                stepLoading.classList.add('hidden');
                stepTVCode.classList.remove('hidden');
                pinBoxes.forEach(b => b.value = '');
                pinBoxes[0].focus();
                return;
            }

            tcdValue.textContent  = data.tvCode || tvCode;
            
            stepLoading.classList.add('hidden');
            stepTVOk.classList.remove('hidden');
            showToast('TV Connected Successfully! Check your TV screen.', 'success');

        } catch (_) {
            showToast('Connection error', 'error');
            stepLoading.classList.add('hidden');
            stepTVCode.classList.remove('hidden');
        }
    }

    /* ═══════ BACK ═══════ */
    backBtn.addEventListener('click', () => {
        hideAll();
        stepInput.classList.remove('hidden'); // Show Step 1 input again
        cdkInput.value = ''; // clear key input
        currentKey = '';
        verifyBtn.disabled = false;
        copyBtnLabel.textContent = 'Copy Login Link';
        copyLinkBtn.disabled = false;
    });

    /* ═══════ BULK VERIFY ═══════ */
    bulkBtn.addEventListener('click', doBulk);

    async function doBulk() {
        const raw = bulkInput.value.trim();
        if (!raw) { showToast('Paste at least one key', 'error'); return; }

        const keys = [...new Set(raw.split(/[\n,;\s]+/).map(k => k.trim()).filter(k => k.length > 5))];
        if (!keys.length) { showToast('No valid keys found', 'error'); return; }

        setLoading(bulkBtn, true);
        bulkResults.classList.add('hidden');
        bulkTbody.innerHTML = '';
        bulkSummary.innerHTML = '';

        let unusedCount = 0, usedCount = 0, invalidCount = 0;
        const workingKeys = [];

        const results = await Promise.all(keys.map(async (key, idx) => {
            try {
                const headers = {'Content-Type':'application/json'};
                const admT = localStorage.getItem('nvx_t');
                if (admT) headers['Authorization'] = 'Bearer ' + admT;
                const res  = await fetch('/api/check-cdk', {
                    method:'POST', headers,
                    body: JSON.stringify({ key })
                });
                const data = await res.json();
                return { idx: idx+1, key, ok: res.ok, data };
            } catch (_) {
                return { idx: idx+1, key, ok: false, data:{ status:'invalid', error:'Connection error' } };
            }
        }));

        results.forEach(r => {
            const d = r.data || {};
            const isNotFound = d.status === 'not_found' || d.status === 'notfound' || (d.valid === false && !d.status);
            const isUnused = !isNotFound && d.status === 'unused';
            const isUsed = !isNotFound && (d.status === 'used' || d.status === 'active' || d.status === 'expired' || !!d.activatedAt);
            const isInvalid = isNotFound || d.status === 'invalid';

            if (isUnused) unusedCount++;
            else if (isUsed) usedCount++;
            else invalidCount++;

            let plan = d.planType || '—';
            if (plan.toLowerCase() === 'premium') {
                plan = 'Premium 4K';
            } else if (plan.toLowerCase() === 'standard') {
                plan = 'Standard 1080p';
            } else if (plan.toLowerCase() === 'basic') {
                plan = 'Basic 1080p';
            } else if (plan.toLowerCase() === 'tv') {
                plan = 'TV Activation';
            }

            let pill;
            if (d.status === 'rate_limited') {
                pill = '<span class="status-pill warn" style="background: rgba(234,179,8,0.15); color: #eab308; border: 1px solid rgba(234,179,8,0.3);"><i class="fa-solid fa-clock"></i> Rate Limited</span>';
            } else if (isUnused) {
                pill = '<span class="status-pill ok"><i class="fa-solid fa-check"></i> Unused</span>';
                workingKeys.push(r.key);
            } else if (isUsed) {
                pill = '<span class="status-pill expired" style="background: rgba(229,9,20,0.15); color: #ff5252; border: 1px solid rgba(229,9,20,0.3);"><i class="fa-solid fa-fire"></i> Used</span>';
            } else {
                pill = '<span class="status-pill invalid"><i class="fa-solid fa-xmark"></i> Non-Existent</span>';
            }

            let actDate = '—';
            if (d.activatedAt) {
                actDate = d.activatedAt.slice(0, 10);
            }

            let warrantyText = '—';
            if (isInvalid) {
                warrantyText = '<span style="color: var(--red); font-weight: 600;">Code Does Not Exist</span>';
            } else if (isUsed) {
                if (d.warrantyType === 'no_warranty' || !d.durationDays) {
                    warrantyText = '<span style="color: var(--t3);">No Warranty</span>';
                } else {
                    const days = d.warrantyDaysLeft !== null ? d.warrantyDaysLeft : 0;
                    if (days > 0) {
                        warrantyText = `<span style="color: #60a5fa; font-weight: 600;">Active Warranty (${days} days left)</span>`;
                    } else {
                        warrantyText = '<span style="color: var(--red); font-weight: 600;">Expired Warranty</span>';
                    }
                }
            } else if (d.warrantyType === 'no_warranty' || !d.durationDays) {
                warrantyText = '<span style="color: var(--t3);">No Warranty</span>';
            } else if (isUnused) {
                warrantyText = `<span>${d.durationDays || 30} Days Warranty</span>`;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${r.idx}</td>
                <td><code style="font-family: monospace; font-weight: 600; background: rgba(255,255,255,0.05); padding: 3px 6px; border-radius: 4px;">${r.key}</code></td>
                <td>${plan}</td>
                <td>${pill}</td>
                <td>${actDate}</td>
                <td>${warrantyText}</td>
            `;
            bulkTbody.appendChild(tr);
        });

        // Setup Copy All Working Keys button
        const copyAllBtn = document.getElementById('copy-all-btn');
        if (workingKeys.length > 0) {
            copyAllBtn.classList.remove('hidden');
            const freshBtn = copyAllBtn.cloneNode(true);
            copyAllBtn.parentNode.replaceChild(freshBtn, copyAllBtn);
            
            freshBtn.addEventListener('click', () => {
                copyText(workingKeys.join('\n'));
                showToast(`Copied ${workingKeys.length} working keys!`, 'success');
            });

            // Setup Download TXT button
            const downloadBtn = document.getElementById('download-txt-btn');
            downloadBtn.classList.remove('hidden');
            const freshDownload = downloadBtn.cloneNode(true);
            downloadBtn.parentNode.replaceChild(freshDownload, downloadBtn);
            
            freshDownload.addEventListener('click', () => {
                const blob = new Blob([workingKeys.join('\n')], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'keys.txt';
                a.click();
                URL.revokeObjectURL(url);
            });
        } else {
            copyAllBtn.classList.add('hidden');
            document.getElementById('download-txt-btn').classList.add('hidden');
        }

        bulkSummary.innerHTML = `
            <span class="bs-chip total"><i class="fa-solid fa-list"></i> Total: ${keys.length}</span>
            <span class="bs-chip valid"><i class="fa-solid fa-check"></i> Unused: ${unusedCount}</span>
            <span class="bs-chip invalid" style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border-color: rgba(59, 130, 246, 0.3);"><i class="fa-solid fa-bolt"></i> Active/Used: ${usedCount}</span>
            <span class="bs-chip invalid"><i class="fa-solid fa-xmark"></i> Invalid/Deleted: ${invalidCount}</span>
        `;
        bulkResults.classList.remove('hidden');
        setLoading(bulkBtn, false);
        bulkResults.scrollIntoView({ behavior:'smooth', block:'nearest' });
        showToast(`Checked ${keys.length} keys`, 'success');
    }

    /* ═══════ ANTI-DEVTOOLS & RIGHT-CLICK SECURITY ═══════ */
    // Disable Right-Click Context Menu
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
    });

    // Disable DevTools & View-Source Shortcuts
    document.addEventListener('keydown', (e) => {
        // F12 key
        if (e.keyCode === 123) {
            e.preventDefault();
            return false;
        }
        // Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+Shift+C (Inspect Element / Console)
        if (e.ctrlKey && e.shiftKey && (e.keyCode === 73 || e.keyCode === 74 || e.keyCode === 67)) {
            e.preventDefault();
            return false;
        }
        // Ctrl+U (View Source)
        if (e.ctrlKey && e.keyCode === 85) {
            e.preventDefault();
            return false;
        }
        // Ctrl+S (Save Page)
        if (e.ctrlKey && e.keyCode === 83) {
            e.preventDefault();
            return false;
        }
    });
});
