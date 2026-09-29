import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getGame } from '../game/GameState';
import { useGameStore } from '../stores/useGameStore';
import { isGunId } from '../data/weapons';
import type { ShopItem } from '../data/shop';
import type { InteriorRoom } from '../systems/InteriorSystem';
import { uiNav } from './UiNav';
import { useUiFocus, useUiInputKind, useUiPress, useUiSurface } from './useUiNav';

/**
 * Balcão de venda. Abre pelo `InteriorSystem.interact` e congela a simulação
 * enquanto o jogador escolhe, igual ao mapa.
 */
export function ShopMenu() {
  const shopOpen = useGameStore((s) => s.shopOpen);
  const shop = shopOpen ? getGame().interiors.active?.shop ?? null : null;
  // Em cartão próprio: a lista só entra no navegador de menus com o balcão aberto.
  if (!shopOpen || !shop) return null;
  return <ShopPanel shop={shop} />;
}

function ShopPanel({ shop }: { shop: NonNullable<InteriorRoom['shop']> }) {
  const game = getGame();
  // Toda compra passa por aqui, então um contador local basta para repintar preço e posse.
  const [revision, setRevision] = useState(0);
  const focus = useUiFocus('shop');
  const press = useUiPress('shop');
  const kind = useUiInputKind();
  const list = useRef<ScrollView>(null);
  const rowY = useRef(new Map<string, number>());
  const rowH = useRef(52);
  const viewport = useRef(0);
  const money = game.player.money;
  const owns = (item: ShopItem) => item.kind === 'gun' && isGunId(item.gun!) && game.weapons.owned.has(item.gun!);
  const close = () => useGameStore.closeShop();
  const buy = (item: ShopItem) => {
    if (game.purchaseShopItem(item.id)) setRevision((n) => n + 1);
  };
  const rows = shop.items.map((item) => {
    const taken = owns(item);
    const affordable = money >= item.price;
    return { item, taken, affordable, blocked: taken || !affordable };
  });
  useUiSurface('shop', {
    items: () => [
      ...rows.map(({ item, blocked }) => ({ id: item.id, disabled: blocked, onSelect: () => buy(item) })),
      { id: 'close', onSelect: close },
    ],
    // LB/RB (PageUp/PageDown) viram o cardápio de páginas, não linha a linha.
    onAction: (action) => {
      if (action !== 'prev' && action !== 'next') return;
      const page = Math.max(1, Math.round(viewport.current / rowH.current));
      uiNav.move('shop', action === 'prev' ? -page : page);
    },
    onBack: close,
  });
  useEffect(() => {
    const y = rowY.current.get(focus);
    if (y === undefined) return;
    // A linha focada tem de ficar à vista: centraliza no meio da janela visível.
    list.current?.scrollTo({ y: Math.max(0, y - viewport.current / 2 + rowH.current / 2), animated: false });
  }, [focus, revision, shop.title]);
  return (
    <View style={styles.overlay} testID="shop-menu">
      <View style={styles.panel}>
        <Text style={styles.title} testID="shop-title">{shop.title.toUpperCase()}</Text>
        <Text style={styles.subtitle} testID="shop-cash">
          {`Em caixa: $${money}`}
        </Text>
        <ScrollView
          ref={list}
          style={styles.list}
          showsVerticalScrollIndicator={false}
          onLayout={(event) => { viewport.current = event.nativeEvent.layout.height; }}
        >
          {rows.map(({ item, taken, affordable, blocked }) => (
            <TouchableOpacity
              key={item.id}
              testID={`shop-row-${item.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: focus === item.id, disabled: blocked }}
              style={[styles.row, focus === item.id && styles.rowFocus]}
              disabled={blocked}
              onPressIn={() => press(item.id)}
              // Tocar na linha compra; sem isso o toque pequeno no preço era o único caminho.
              onPress={() => buy(item)}
              onLayout={(event) => {
                rowY.current.set(item.id, event.nativeEvent.layout.y);
                rowH.current = Math.max(1, event.nativeEvent.layout.height);
              }}
            >
              <View style={styles.rowText}>
                <Text style={styles.itemLabel} numberOfLines={1}>{item.label}</Text>
                <Text style={styles.itemNote} numberOfLines={1}>
                  {taken ? 'Na coleção' : item.note ?? (item.health ? `Vida +${item.health}` : '—')}
                </Text>
              </View>
              <TouchableOpacity
                testID={`shop-buy-${item.id}`}
                disabled={blocked}
                style={[styles.buy, taken && styles.buyOwned, !taken && !affordable && styles.buyPoor]}
                onPress={() => buy(item)}
              >
                <Text style={styles.buyText}>{taken ? 'SEU' : `$${item.price}`}</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <Text style={styles.message} testID="shop-message">{game.interiors.message || ' '}</Text>
        <TouchableOpacity
          style={[styles.close, focus === 'close' && styles.closeFocus]}
          onPress={close}
          onPressIn={() => press('close')}
          testID="shop-close"
        >
          <Text style={styles.closeText}>SAIR DO BALCÃO</Text>
        </TouchableOpacity>
        {kind !== 'touch' && (
          <Text style={styles.keys} testID="shop-keys">
            {kind === 'gamepad' ? 'D-pad linha · LB/RB página · A comprar · B sair'
              : '↑↓ linha · PageUp/Down página · Enter comprar · Backspace sair'}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(6,9,14,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  panel: {
    width: 330,
    maxHeight: '94%',
    backgroundColor: '#181c24',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 8,
  },
  title: { color: '#ffe9a8', fontSize: 18, fontWeight: '800', letterSpacing: 2 },
  subtitle: { color: '#9fd6a4', fontSize: 12, fontWeight: '700', marginBottom: 4 },
  // A lista precisa caber no painel, nunca estourar por cima do recibo e do botão de sair:
  // com flexGrow 0 o painel de altura máxima fechada não limita o ScrollView, a última linha
  // do cardápio é desenhada por fora dele, e por cima dela fica o texto da mensagem — que
  // rouba o toque. Rolar é o único jeito de chegar na última linha de um cardápio cheio.
  list: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.07)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0)',
  },
  // Foco de teclado/controle na linha inteira, não só no preço.
  rowFocus: {
    borderColor: '#ffe9a8',
    backgroundColor: 'rgba(255,233,168,0.1)',
  },
  rowText: { flex: 1 },
  itemLabel: { color: '#fff', fontSize: 14, fontWeight: '800' },
  itemNote: { color: '#96a2b3', fontSize: 11 },
  buy: {
    minWidth: 74,
    borderRadius: 9,
    paddingVertical: 9,
    paddingHorizontal: 8,
    alignItems: 'center',
    backgroundColor: 'rgba(70,180,255,0.9)',
  },
  buyPoor: { backgroundColor: 'rgba(90,100,120,0.6)' },
  buyOwned: { backgroundColor: 'rgba(120,90,190,0.55)' },
  buyText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  message: { color: '#f2c063', fontSize: 12, fontWeight: '700', minHeight: 16 },
  close: {
    backgroundColor: 'rgba(200,90,80,0.9)',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0)',
  },
  closeFocus: { borderColor: '#ffe9a8' },
  closeText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 1 },
  keys: { color: 'rgba(255,233,168,0.75)', fontSize: 9, fontWeight: '700', textAlign: 'center' },
});
