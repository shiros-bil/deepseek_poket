const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../app/src/main/assets/engine/server.js').__test;
test('Simulated temperature and token budget have separate boundaries; missing and invalid values ignored',()=>{
 for(const key of ['max_tokens','max_output_tokens','max_completion_tokens']){
  const f=core.formatMessages([{role:'system',content:'SYS'},{role:'user',content:'USER'}],[],{temperature:0.7,[key]:123});
  assert.ok(f.systemPrompt.includes('</system_instructions>\n\n<HIGH_PRIORITY_GENERATION_SETTINGS>'));
  assert.ok(f.systemPrompt.includes('temperature were 0.7'));assert.ok(f.systemPrompt.includes('123 tokens'));assert.ok(f.systemPrompt.endsWith('</HIGH_PRIORITY_GENERATION_SETTINGS>'));assert.ok(f.prompt.includes('USER'));
 }
 assert.ok(core.simulatedGenerationSettings({temperature:0}).block.includes('temperature were 0'));
 assert.equal(core.simulatedGenerationSettings({temperature:'inject',max_tokens:-1}).block,'');
 assert.equal(core.simulatedGenerationSettings({}).block,'');
 assert.equal(core.simulatedGenerationSettings({max_tokens:200,max_output_tokens:100}).maxTokens,100);
 for(const mode of ['openai','anthropic','responses']){
  const p=core.normalizeApiParams({temperature:0.7,max_tokens:123,messages:[{role:'user',content:'Hi'}],input:'Hi'},mode);assert.ok(core.formatMessages(p.messages,[],p).systemPrompt.includes('123 tokens'));
 }
});
