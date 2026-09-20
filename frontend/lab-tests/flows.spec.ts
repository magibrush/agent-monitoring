import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

test('tabs isolate settings and submit exactly the advertised request count', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Load test', exact: true }).click();
  await page.locator('#advanced summary').click();
  await page.locator('#policies').uncheck();
  await page.getByRole('button', { name: 'Provider recovery' }).click();
  await expect(page.locator('#policies')).not.toBeChecked();
  await expect(page.locator('[data-kit="retry"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#count').fill('12');
  await expect(page.locator('[data-kit="retry"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#advanced-summary')).toContainText('fails once');
  await page.getByRole('tab', { name: 'Custom request' }).click();
  await expect(page.locator('#run-summary')).toHaveText('1 custom request');
  await expect(page.locator('#count')).toBeHidden();
  await page.locator('#mode').selectOption('live');
  await expect(page.locator('#expectations-title')).toHaveText('Expected result');
  await expect(page.locator('#run-note')).toContainText('paid API calls');
  await expect(page.locator('#expectations-help')).toContainText('not sent to the judge');
  const configs: any[] = [];
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    configs.push(route.request().postDataJSON());
    await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({detail:'Intercepted for UI test'})});
  });
  await page.getByRole('button', { name: 'Test request' }).click();
  await expect.poll(()=>configs.length).toBe(1);
  expect(configs[0]).toMatchObject({count:1,concurrency:1,mode:'live',fault:'none',duplicates:false});
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).click();
  await expect(page.locator('#mode')).toHaveValue('scripted');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page.locator('.scenario input').first().uncheck();
  await expect(page.getByRole('button', { name: 'Select all', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run 19 scenarios' }).click();
  await expect.poll(()=>configs.length).toBe(2);
  expect(configs[1].count).toBe(configs[1].scenarios.length);
  expect(configs[1]).toMatchObject({mode:'scripted',fault:'none',count:19});
  await page.getByRole('tab', { name: 'Load test', exact: true }).click();
  await expect(page.locator('#count')).toHaveValue('12');
  await page.getByRole('button', { name: 'Start load test' }).click();
  await expect.poll(()=>configs.length).toBe(3);
  expect(configs[2]).toMatchObject({count:12,fault:'retry_once',mode:'scripted',policies:false});
});

test('cards fit wide and narrow screens and tabs support the keyboard', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.scenario')).toHaveCount(20);
  for (const width of [1920, 1440, 900, 390]) {
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
    const cards=await page.locator('.scenario').evaluateAll(elements=>elements.map(e=>({width:e.clientWidth,scroll:e.scrollWidth,right:e.getBoundingClientRect().right})));
    expect(cards.every(c=>c.scroll<=c.width&&c.right<=width)).toBeTruthy();
    if(width===1920)await page.screenshot({path:resolve(testInfo.config.rootDir,'../../data/lab-wide.png'),fullPage:true});
  }
  await page.getByRole('button', { name: 'View request: Open a pull request' }).click();
  await expect(page.getByRole('dialog')).toContainText('create_pull_request');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Scenarios', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Custom request' })).toBeFocused();
  await expect(page.locator('#custom-fields')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#load-view')).toBeVisible();
  await expect(page.locator('#scenario-list')).toBeHidden();
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:resolve(testInfo.config.rootDir,'../../data/lab-load.png'),fullPage:true});
});
