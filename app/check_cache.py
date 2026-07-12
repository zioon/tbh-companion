import json

with open('C:/Users/zioon/AppData/Roaming/tbh-companion/prices.CNY.json', 'r') as f:
    data = json.load(f)

items_to_check = ['Arcane Crystal', 'Wyvern Claw', 'Soulstone - Hell', 'Minor Ruby', 'Mystic Topaz', 'Enchanted Ruby', 'Opal']
prices = data.get('prices', {})
print('Total entries:', len(prices))
for item in items_to_check:
    if item in prices:
        entry = prices[item]
        print('%s: lowest=%s median=%s volume=%s' % (item, entry.get("lowest"), entry.get("median"), entry.get("volume")))
    else:
        matches = [k for k in prices.keys() if item.split()[0] in k]
        print('%s: NOT FOUND (similar: %s)' % (item, matches[:3]))
