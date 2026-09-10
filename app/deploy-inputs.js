export function describeDeploySelection(entry) {
 if (!entry?.inputs) return '';
 const inputs = Object.entries(entry.inputs).map(([name, value]) => `${name}=${value}`).join(', ');
 return inputs + (entry.targetVersion ? ` | ${entry.currentVersion || 'unpublished'} -> ${entry.targetVersion}` : '');
}

export function deployInputNotice(manifest, stale = false) {
 if (stale) return 'Choices or versions changed. Reopen this panel or reload this page before deploying.';
 if (!manifest?.inputs.length) return 'No input selections required. This script runs from the project workspace.';
 return manifest.version
  ? 'Choose explicitly. Published versions are specific to the selected identity.'
  : 'Choose a value for every required deployment input.';
}

export function renderDeployInputs(manifest, idPrefix, esc) {
 if (!manifest.inputs.length) return '';
 const selects = manifest.inputs.map(input => {
  const id = `${idPrefix}-${input.name}`;
  return `<label class="deploy-input-field" for="${esc(id)}"><span class="deploy-input-label">${esc(input.label)}</span>`
   + `<select class="deploy-input" id="${esc(id)}" name="${esc(input.name)}" required>`
   + `<option value="">Choose ${esc(input.label)}</option>`
   + input.choices.map(choice => `<option value="${esc(choice.value)}">${esc(choice.label)}</option>`).join('')
   + '</select></label>';
 }).join('');
 const version = manifest.version
  ? '<div class="selection-version" role="status" aria-live="polite">Published: <span class="version current-version">Choose an identity</span> Anticipated: <span class="version target-version">Choose a version bump</span></div>'
  : '';
 return `<div class="deploy-inputs">${selects}</div>${version}`;
}

// Shared by both deployment surfaces. Version arithmetic stays on the server;
// the client displays the resolved choice's published and anticipated metadata.
export function createDeployInputsClient(describe, noticeText) {
 function managed(card) { return card.dataset.managed === '1'; }
 function state(card) { return card.dataset.manifest ? JSON.parse(card.dataset.manifest) : null; }
 function values(card) {
  return Object.fromEntries([...card.querySelectorAll('.deploy-input')].map(select => [select.name, select.value]));
 }
 function ready(card) {
  if (card.dataset.deployBusy === '1') return false;
  if (!managed(card)) return true;
  const slot = state(card), selected = values(card);
  return !!slot && card.dataset.manifestStale !== '1'
   && slot.inputs.every(input => input.choices.some(choice => choice.value === selected[input.name]));
 }
 function selection(card) {
  const slot = state(card), inputs = values(card);
  const versionInput = slot?.inputs.find(input => input.name === slot.version?.input);
  const choice = versionInput?.choices.find(item => item.value === inputs[versionInput.name]);
  return {
   inputs,
   currentVersion: choice?.version ?? null,
   targetVersion: choice?.targetVersions?.[inputs[slot?.version?.bumpInput]] ?? null,
  };
 }
 function update(card) {
  const slot = state(card);
  const selects = card.querySelectorAll('.deploy-input');
  for (const select of selects) select.disabled = card.dataset.deployBusy === '1';
  const btn = card.querySelector('.deploy-btn');
  if (btn) btn.disabled = !ready(card);
  const notice = card.querySelector('.manifest-notice');
  if (notice) notice.textContent = noticeText(slot, card.dataset.manifestStale === '1');
  if (!slot?.version) return;
  const selected = values(card);
  const input = slot.inputs.find(item => item.name === slot.version.input);
  const choice = input.choices.find(item => item.value === selected[input.name]);
  const current = card.querySelector('.current-version');
  const target = card.querySelector('.target-version');
  if (current) current.textContent = choice ? (choice.version || `Not published (initial ${choice.initialVersion})`) : `Choose ${input.label}`;
  if (target) target.textContent = choice?.targetVersions?.[selected[slot.version.bumpInput]] || 'Choose both selections';
 }
 function bind(container) {
  container.querySelectorAll('.target-card[data-managed="1"]').forEach(card => {
   card.querySelectorAll('.deploy-input').forEach(select => select.addEventListener('change', () => update(card)));
   update(card);
  });
 }
 function collect(card) {
  if (!managed(card)) return { option: (card.querySelector('.deploy-option') || {}).value || '' };
  if (!ready(card)) {
   const output = card.querySelector('.deploy-output');
   if (output) {
    output.classList.add('show');
    output.textContent = card.dataset.manifestStale === '1'
     ? 'Choices or versions changed. Reopen this panel or reload this page.'
     : 'Select a valid value for every required deployment input.';
   }
   const invalid = [...card.querySelectorAll('.deploy-input')].find(select => !select.value);
   if (invalid) { invalid.reportValidity(); invalid.focus(); }
   return null;
  }
  return { inputs: values(card), manifestRevision: state(card).revision };
 }
 function setBusy(card, busy) {
  card.dataset.deployBusy = busy ? '1' : '0';
  update(card);
 }
 function applyResult(card, result) {
  if (!managed(card)) return;
  const fresh = result.manifest, previous = state(card), selected = values(card);
  if (fresh) {
   const sameInputs = previous && fresh.script === previous.script
    && JSON.stringify(fresh.version) === JSON.stringify(previous.version)
    && fresh.inputs.length === previous.inputs.length
    && fresh.inputs.every((input, index) => input.name === previous.inputs[index].name && input.env === previous.inputs[index].env);
   if (sameInputs) {
    card.dataset.manifest = JSON.stringify(fresh);
    card.dataset.manifestStale = '0';
    card.querySelectorAll('.deploy-input').forEach(select => {
     const input = fresh.inputs.find(item => item.name === select.name);
     select.replaceChildren();
     for (const choice of [{ value: '', label: `Choose ${input.label}` }, ...input.choices]) {
      const option = select.ownerDocument.createElement('option');
      option.value = choice.value; option.textContent = choice.label;
      select.appendChild(option);
     }
     select.value = input.choices.some(choice => choice.value === selected[input.name]) ? selected[input.name] : '';
     const label = select.closest('label')?.querySelector('.deploy-input-label');
     if (label) label.textContent = input.label;
    });
    const script = card.querySelector('.deploy-script');
    if (script) script.value = fresh.script;
   } else card.dataset.manifestStale = '1';
  }
  if (result.staleManifest) card.dataset.manifestStale = '1';
  update(card);
 }
 return { bind, collect, setBusy, applyResult, ready, history: describe, describe: card => managed(card) ? describe(selection(card)) : '' };
}

export const deployInputsClientSrc = `const deployInputs = (${createDeployInputsClient.toString()})(${describeDeploySelection.toString()}, ${deployInputNotice.toString()});`;
