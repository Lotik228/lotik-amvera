import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { createLotikMarket } from './lotik-market.mjs';
import { openStore } from './store.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAKCAIAAAAPTiitAAAAF0lEQVR4nGMMb9ZiIASYCKoYVUR0EAAAheIBGN9dX9UAAAAASUVORK5CYII=', 'base64');
const now = 1_700_000_000;
const standardInput = {
  title: 'Фотоаппарат', price: '2500', category: 'electronics', city: 'Москва', district: 'Сокол',
  description: 'Плёночная камера, исправна.', photos: [], contact: 'username', acceptRules: true,
};

function setup(t, useDisk = false) {
  const dir = useDisk ? mkdtempSync(join(tmpdir(), 'lotik-market-test-')) : ':memory:';
  let db;
  let service;
  const sent = [];
  const restart = () => {
    db?.close();
    db = openStore(dir,'delete');
    service = createLotikMarket(db, dir, async (_, message) => {
      sent.push(message);
      return { message_id: sent.length };
    });
    return db;
  };
  const call = (path, userId, method = 'GET', input, time = now, data) => {
    const url = new URL('https://lotik.test' + path);
    const req = data ? Readable.from([data]) : {};
    req.method = method;
    req.headers = {};
    return service.route({ path: url.pathname, req, url, userId, isOwner: userId === 42, now: time, body: async () => input });
  };
  const initial = restart();
  initial.exec("INSERT INTO users VALUES (7,'Seller','seller_valid'),(8,'Buyer','buyer_valid'),(9,'Relay seller',NULL),(42,'Owner','owner_valid');");
  t.after(() => {
    db.close();
    if (!useDisk) return;
    const images = join(dir, 'lotik-market-photos');
    for (const name of readdirSync(dir)) {
      if (name === 'lotik-market-photos') {
        for (const photo of readdirSync(images)) unlinkSync(join(images, photo));
        rmdirSync(images);
      } else unlinkSync(join(dir, name));
    }
    rmdirSync(dir);
  });
  return { call, restart, get db() { return db; }, get service() { return service; }, sent };
}

test('market persists reordered, validated JPEG files and keeps draft media private', async t => {
  const { call, restart, ...context } = setup(t, true);
  const upload = (user, image) => call('/photos', user, 'POST', null, now, image);
  await assert.rejects(upload(7, Buffer.from('<svg><script>alert(1)</script></svg>')), { status: 400 });
  const first = (await upload(7, Buffer.concat([png,Buffer.from('SECRET EXIF TRAILER')]))).id;
  const second = (await upload(7,png)).id;
  const third = (await upload(7,png)).id;
  const foreign = (await upload(8,png)).id;
  await assert.rejects(call('/photos/' + first, 8), { status: 404 });
  await assert.rejects(call('/ads', 7, 'POST', { ...standardInput, photos:[foreign] }), { status: 400 });
  const { id } = await call('/ads', 7, 'POST', { ...standardInput, photos:[second,first,third] });
  await assert.rejects(context.service.publicImage(first), { status: 404 });
  assert.equal((await call('/ads',8)).rows.length, 0);
  await assert.rejects(call('/ads/' + id + '/edit',8,'PUT',{...standardInput,revision:1}), { status:404 });
  await call('/ads/' + id + '/edit',7,'PUT',{...standardInput,photos:[third,second],revision:1});
  await assert.rejects(call('/photos/' + first,7),{status:404});
  await call('/moderation/' + id,42,'POST',{action:'approve',revision:2});
  const db = restart();
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal((await call('/ads',8)).rows[0].cover, third);
  assert.deepEqual((await call('/ads/' + id,8)).photos,[third,second]);
  const image = await call('/photos/' + second,7);
  assert.deepEqual([...image.subarray(0,2)],[255,216]);
  assert.equal(image.includes('SECRET EXIF TRAILER'),false);
  const ad = await call('/ads/' + id + '/edit',7);
  await call('/ads/' + id + '/status',7,'POST',{action:'delete',revision:ad.revision});
  await assert.rejects(call('/photos/' + second,7),{status:404});
});

test('internal market supports filtered public listings, favorites, ownership and moderation', async t => {
  const { call, db, service } = setup(t);
  db.prepare('INSERT INTO market_listings(id,title,city,category,price,url,posted_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('1234567','AVITO IMPORT','Москва','electronics',12,'https://avito.ru/items/1234567',now,now);
  const { id } = await call('/ads',7,'POST',{...standardInput,title:'Камера <script>test</script>'});
  await assert.rejects(call('/moderation',8),{status:403});
  await assert.rejects(call('/ads/' + id,8),{status:404});
  await call('/moderation/' + id,42,'POST',{action:'approve',revision:1});
  const ad = await call('/ads/' + id,8);
  assert.equal(ad.telegramUrl,'https://t.me/seller_valid');
  assert.equal(ad.title,'Камера <script>test</script>');
  for (const field of ['telegram_id','owner_id','telegramId','ownerId']) assert.equal(ad[field],undefined);
  const found = await call('/ads?q=плёночная&city=москва&category=electronics&min=2000&max=2600&sort=cheap',8);
  assert.deepEqual(found.rows.map(row=>row.id),[id]);
  assert.deepEqual((await call('/ads?q=AVITO',8)).rows,[]);
  await call('/ads/'+id+'/favorite',8,'PUT',{saved:true});
  assert.equal((await call('/favorites',8)).rows[0].id,id);
  await call('/ads/'+id+'/report',8,'POST',{reason:'Проверьте описание'});
  assert.equal((await call('/moderation?queue=reports',42)).rows[0].id,id);
  await call('/moderation/'+id,42,'POST',{action:'remove',revision:2,note:'Уточните описание'});
  assert.deepEqual((await call('/favorites',8)).rows,[]);
  await call('/ads/'+id+'/status',7,'POST',{action:'republish',revision:3});
  assert.equal((await call('/ads/'+id+'/edit',7)).status,'pending');
  await call('/moderation/'+id,42,'POST',{action:'approve',revision:4});
  await call('/ads/'+id+'/status',7,'POST',{action:'sold',revision:5});
  assert.equal((await call('/ads/'+id+'/edit',7)).status,'sold');
  await call('/moderation/'+id,42,'POST',{action:'block',revision:6});
  await assert.rejects(call('/ads',7,'POST',standardInput),{status:403});
  await assert.rejects(service.publicImage('a'.repeat(32)),{status:404});
});

test('web account links to a signed Telegram account and bot mediates replies without exposing IDs', async t => {
  const { call, service, sent, db } = setup(t);
  await assert.rejects(call('/ads',-17,'POST',{...standardInput,contact:'bot'}),{status:403});
  const { code } = await call('/link',-17,'POST',{});
  await assert.rejects(call('/link',9,'POST',{code,confirm:false}),{status:400});
  await call('/link',9,'POST',{code,confirm:true});
  await assert.rejects(call('/link',8,'POST',{code,confirm:true}),{status:400});
  const { id } = await call('/ads',-17,'POST',{...standardInput,contact:'bot',telegramId:8,username:'spoofed'});
  assert.equal((await call('/mine',9)).rows[0].id,id);
  assert.equal((await call('/ads/'+id+'/edit',9)).id,id);
  await assert.rejects(call('/ads/'+id+'/edit',8),{status:404});
  await call('/moderation/'+id,42,'POST',{action:'approve',revision:1});
  assert.equal((await call('/ads/'+id,8)).telegramUrl,null);
  await call('/ads/'+id+'/contact',8,'POST',{message:'Готов купить'});
  assert.deepEqual(sent.map(message=>message.chat_id),[8,9]);
  assert.equal(await service.relayReply({message:{from:{id:9},chat:{id:9,type:'private'},text:'Пишите завтра',reply_to_message:{message_id:2}}},now),true);
  assert.equal(sent[2].chat_id,8);
  assert.match(sent[2].text,/Пишите завтра/);
  assert.equal(await service.relayReply({message:{from:{id:7},chat:{id:7,type:'private'},text:'fake',reply_to_message:{message_id:2}}},now),false);
  const seed = db.prepare(`INSERT INTO lotik_market_ads (owner_id,telegram_id,title,description,search_text,price,category,city,city_key,district,status,created_at,updated_at,published_at)
    VALUES (7,7,'Fixture','fixture','fixture',?,'electronics','Москва','москва','','active',?,?,?)`);
  for (let i=0; i<20; i++) seed.run(i,now,now,now);
  const page = await call('/ads?sort=cheap',8);
  assert.equal(page.rows.length,16);
  const rest = await call('/ads?sort=cheap&cursor='+page.next,8);
  assert.equal(new Set([...page.rows,...rest.rows].map(row=>row.id)).size,21);
  assert.equal(rest.next,null);
  for (let i=0;i<6;i++) await call('/ads',7,'POST',standardInput);
  await assert.rejects(call('/ads',7,'POST',standardInput),{status:429});
});
