import {expect, test} from 'vitest';
import {historySessionLinks} from '../client/history-sessions';
import type {ReplyEntry} from '../shared/reply-history';

const original = {sessionId:'work',cardId:'draft',revision:'sha',questions:[]};
const saved:ReplyEntry = {key:'one',status:'recorded',title:'Which draft?',projectId:'production',at:'2026-11-22T10:00:00Z',origin:original};
const directory = {
  hostId:'studio',
  sessions:[{id:'work',projectId:'checkout',title:'Draft session',status:'closed',lane:'idle' as const}],
  repos:new Map([['production','example/site'],['checkout','example/site']]),
  peers:[{host:{serverId:'laptop',label:'Laptop'},rows:[{sessionId:'work',projectId:'production',title:'Remote draft'}]}],
};

test('saved-only receipts can open the source in a selected checkout of the same repo, including a closed conversation',()=>{
  expect(historySessionLinks(saved,directory)).toEqual([{role:'source',id:'work',title:'Draft session',state:'closed',available:true}]);
  expect(historySessionLinks(saved,{...directory,repos:new Map()})).toEqual([{role:'source',id:'work',available:false}]);
  expect(historySessionLinks(saved,{...directory,sessions:[]})).toEqual([{role:'source',id:'work',available:false}]);
});
test('successful delivery and its source stay distinct unless both host and session match',()=>{
  const sent={...saved,status:'sent' as const,recipientId:'work',recipientTitle:'Received here',canOpen:true};
  expect(historySessionLinks(sent,directory).map(x=>x.role)).toEqual(['received']);
  const remote={...sent,origin:{...original,sessionHost:'laptop'}};
  expect(historySessionLinks(remote,directory)).toMatchObject([{role:'received',id:'work'},{role:'source',id:'work',host:'laptop',title:'Remote draft',available:true}]);
  expect(historySessionLinks({...sent,recipientId:'coordinator'},directory).map(x=>[x.role,x.id])).toEqual([['received','coordinator'],['source','work']]);
  expect(historySessionLinks({...remote,origin:{...original,sessionHost:'deleted-host'}},directory)[1]).toMatchObject({host:'deleted-host',available:false});
});
test('pending receipts and queued merge notices never label the target as having received a reply',()=>{
  expect(historySessionLinks({...saved,status:'pending',recipientId:'work',canOpen:true},directory).map(x=>x.role)).toEqual(['target']);
  const merge={status:'merged' as const,repo:'example/site',number:9,mergeSha:null};
  for(const [status,role] of [['sent','received'],['queued','target'],['unconfirmed','target']] as const){
    expect(historySessionLinks({...saved,origin:undefined,pullMerge:{...merge,notification:{status,recipientId:'work'}}},directory)).toMatchObject([{role,id:'work',title:'Draft session',available:true}]);
  }
});
