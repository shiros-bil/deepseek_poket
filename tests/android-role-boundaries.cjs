const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../app/src/main/assets/engine/server.js').__test;
test('Role boundaries and prompts larger than former API and context limits',()=>{
 const large='A'.repeat(11*1024*1024)+'END_OF_REQUEST';
 const formatted=core.formatMessages([{role:'system',content:'Be helpful'},{role:'user',content:large},{role:'assistant',content:'Hello'},{role:'user',content:'Continue'}],[]);
 assert.equal(formatted.systemPrompt,'<system_instructions>\nBe helpful\n</system_instructions>');
 assert.ok(formatted.prompt.includes('<user_message>\n'+large+'\n</user_message>'));
 assert.ok(formatted.prompt.includes('<assistant_message>\nHello\n</assistant_message>'));
 const built=core.buildBoundedPrompt(formatted.systemPrompt,'',formatted.prompt);assert.equal(built.compacted,false);assert.ok(built.prompt.includes('END_OF_REQUEST'));
});
