/**
 * 系列设定：角色、衣橱、场景底板、当天物件位置。
 */
import { useEffect, useRef, useState } from 'react'
import { Button, Drawer, Flex, Image, Input, Modal, Select, Space, Tabs, Tooltip, Typography, Upload } from 'antd'
import {
  bibleImageSrc,
  drawBibleImage,
  fetchBible,
  fetchBibleLibrary,
  generateBibleImage,
  reviseBibleLook,
  saveBible,
  uploadBibleImage,
  addVoiceClip,
  deleteVoiceClip,
  renameVoiceClip,
  fetchVoices,
  voiceAudioUrl,
  type BibleCharacter,
  type BibleDay,
  type BibleOutfit,
  type BiblePlace,
  type PropSpot,
  type SeriesBible,
  type VoiceClip,
} from '../api/video'

function nid(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2, 8)}`
}

function spotsOf(day: BibleDay | undefined, place: BiblePlace): PropSpot[] {
  return day?.places[place.id] ?? place.props
}

export function BibleDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [bible, setBible] = useState<SeriesBible | null>(null)
  const [voices, setVoices] = useState<VoiceClip[]>([])
  const [voiceName, setVoiceName] = useState('')
  const [voiceUrl, setVoiceUrl] = useState('')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    void fetchBible()
      .then(setBible)
      .catch(() => setError('设定没有读出来'))
    void fetchVoices()
      .then(setVoices)
      .catch(() => {})
  }, [open])

  const day = bible?.days.find((item) => item.id === bible.activeDayId) ?? bible?.days[0]

  const dirty = useRef(false)

  function patch(next: SeriesBible) {
    dirty.current = true
    setBible(next)
  }

  useEffect(() => {
    if (!open || !bible || !dirty.current) return
    const handle = window.setTimeout(() => {
      dirty.current = false
      void saveBible(bible).catch(() => setError('没存上'))
    }, 700)
    return () => window.clearTimeout(handle)
  }, [bible, open])

  async function onSave() {
    if (!bible) return
    setBusy(true)
    setError('')
    try {
      setBible(await saveBible(bible))
      onClose()
    } catch {
      setError('没存上')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="设定"
      size="large"
      open={open}
      onClose={onClose}
      extra={
        <Button type="primary" loading={busy} onClick={() => void onSave()}>
          保存
        </Button>
      }
    >
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
      {bible && day && (
        <Tabs
          items={[
            {
              key: 'cast',
              label: '角色',
              children: (
                <Flex vertical gap={12}>
                  {bible.characters.map((character) => (
                    <CharacterRow
                      key={character.id}
                      character={character}
                      voices={voices}
                      onChange={(next) =>
                        patch({ ...bible, characters: bible.characters.map((item) => (item.id === character.id ? next : item)) })
                      }
                      onRemove={() =>
                        patch({
                          ...bible,
                          characters: bible.characters.filter((item) => item.id !== character.id),
                          outfits: bible.outfits.filter((item) => item.characterId !== character.id),
                        })
                      }
                    />
                  ))}
                  <Button onClick={() => patch({ ...bible, characters: [...bible.characters, { id: nid('c'), name: '', look: '' }] })}>
                    加一个角色
                  </Button>
                </Flex>
              ),
            },
            {
              key: 'voices',
              label: '音色',
              children: (
                <Flex vertical gap={12}>
                  <Typography.Text type="secondary">贴哔哩哔哩链接，截一段人声放进库里。角色页给每个人选一条。</Typography.Text>
                  {voices.map((voice) => (
                    <Space key={voice.id} align="center">
                      <VoiceName
                        voice={voice}
                        onRename={(name) => {
                          void renameVoiceClip(voice.id, name)
                            .then(setVoices)
                            .catch((err) => setError(err instanceof Error ? err.message : '名字没改成'))
                        }}
                      />
                      <audio src={voiceAudioUrl(voice.id)} controls style={{ height: 32, width: 220 }} />
                      <Button
                        danger
                        onClick={() => {
                          void deleteVoiceClip(voice.id).then(setVoices).catch(() => setError('删不掉'))
                        }}
                      >
                        删除
                      </Button>
                    </Space>
                  ))}
                  <Input placeholder="音色名字" value={voiceName} onChange={(e) => setVoiceName(e.target.value)} />
                  <Space.Compact style={{ width: '100%' }}>
                    <Input
                      placeholder="哔哩哔哩链接"
                      value={voiceUrl}
                      onChange={(e) => setVoiceUrl(e.target.value)}
                    />
                    <Button
                      loading={voiceBusy}
                      onClick={() => {
                        const url = voiceUrl.trim()
                        if (!url) return
                        setVoiceBusy(true)
                        setError('')
                        void addVoiceClip(voiceName, url)
                          .then((voice) => {
                            setVoices((cur) => [...cur, voice])
                            setVoiceUrl('')
                            setVoiceName('')
                          })
                          .catch((err) => setError(err instanceof Error ? err.message : '这段音色没有截出来'))
                          .finally(() => setVoiceBusy(false))
                      }}
                    >
                      提取
                    </Button>
                  </Space.Compact>
                </Flex>
              ),
            },
            {
              key: 'wardrobe',
              label: '衣橱',
              children: (
                <Flex vertical gap={12}>
                  {bible.outfits.map((outfit) => (
                    <OutfitRow
                      key={outfit.id}
                      outfit={outfit}
                      characters={bible.characters}
                      onChange={(next) => patch({ ...bible, outfits: bible.outfits.map((item) => (item.id === outfit.id ? next : item)) })}
                      onRemove={() => patch({ ...bible, outfits: bible.outfits.filter((item) => item.id !== outfit.id) })}
                    />
                  ))}
                  <Button
                    disabled={!bible.characters.length}
                    onClick={() =>
                      patch({
                        ...bible,
                        outfits: [...bible.outfits, { id: nid('o'), characterId: bible.characters[0].id, name: '', look: '' }],
                      })
                    }
                  >
                    加一件衣服
                  </Button>
                </Flex>
              ),
            },
            {
              key: 'places',
              label: '场景',
              children: (
                <Flex vertical gap={12}>
                  <Typography.Text type="secondary">这里写房间本来的样子和物件默认位置。当天没人动过，就一直画在这个位置。</Typography.Text>
                  {bible.places.map((place) => (
                    <PlaceRow
                      key={place.id}
                      place={place}
                      onChange={(next) => patch({ ...bible, places: bible.places.map((item) => (item.id === place.id ? next : item)) })}
                      onRemove={() => patch({ ...bible, places: bible.places.filter((item) => item.id !== place.id) })}
                    />
                  ))}
                  <Button onClick={() => patch({ ...bible, places: [...bible.places, { id: nid('p'), name: '', look: '', props: [] }] })}>
                    加一个场景
                  </Button>
                </Flex>
              ),
            },
            {
              key: 'day',
              label: '当天',
              children: (
                <Flex vertical gap={12}>
                  <Space wrap>
                    <Select
                      value={day.id}
                      style={{ minWidth: 160 }}
                      options={bible.days.map((item) => ({ value: item.id, label: item.title }))}
                      onChange={(id) => patch({ ...bible, activeDayId: id })}
                    />
                    <Button
                      onClick={() => {
                        const next = { id: nid('day'), title: `第${bible.days.length + 1}天`, places: {} }
                        patch({ ...bible, days: [...bible.days, next], activeDayId: next.id })
                      }}
                    >
                      新的一天
                    </Button>
                  </Space>
                  <Input
                    value={day.title}
                    onChange={(e) =>
                      patch({
                        ...bible,
                        days: bible.days.map((item) => (item.id === day.id ? { ...item, title: e.target.value } : item)),
                      })
                    }
                  />
                  <Typography.Text type="secondary">改这里就是改这一天走到现在的位置。下一条同一天的戏会接着这个位置画。</Typography.Text>
                  {bible.places.map((place) => (
                    <PlaceProps
                      key={place.id}
                      title={place.name || '未命名场景'}
                      props={spotsOf(day, place)}
                      onChange={(props) =>
                        patch({
                          ...bible,
                          days: bible.days.map((item) =>
                            item.id === day.id ? { ...item, places: { ...item.places, [place.id]: props } } : item,
                          ),
                        })
                      }
                    />
                  ))}
                </Flex>
              ),
            },
          ]}
        />
      )}
    </Drawer>
  )
}

function VoiceName({ voice, onRename }: { voice: VoiceClip; onRename: (name: string) => void }) {
  const [name, setName] = useState(voice.name)
  useEffect(() => setName(voice.name), [voice.name])
  return (
    <Input
      value={name}
      style={{ width: 140 }}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => {
        const next = name.trim()
        if (!next || next === voice.name) {
          setName(voice.name)
          return
        }
        onRename(next)
      }}
      onPressEnter={(e) => e.currentTarget.blur()}
    />
  )
}

function CharacterRow({
  character,
  voices,
  onChange,
  onRemove,
}: {
  character: BibleCharacter
  voices: VoiceClip[]
  onChange: (next: BibleCharacter) => void
  onRemove: () => void
}) {
  return (
    <Flex vertical gap={6}>
      <Space>
        <Input placeholder="名字，如阿青" value={character.name} onChange={(e) => onChange({ ...character, name: e.target.value })} />
        <Select
          placeholder="音色"
          allowClear
          style={{ minWidth: 140 }}
          value={character.voiceId}
          options={voices.map((voice) => ({ value: voice.id, label: voice.name }))}
          onChange={(voiceId) => onChange({ ...character, voiceId })}
        />
        <Button danger onClick={onRemove}>
          删除
        </Button>
      </Space>
      <RefImage
        images={character.images ?? []}
        prompt={`角色定妆，单人正面半身，纯色浅灰背景。${character.name}。${character.look}`}
        ready={Boolean(character.name.trim() || character.look.trim())}
        onChange={(images) => onChange({ ...character, images })}
      />
      <LookTalk
        kind="character"
        name={character.name}
        look={character.look}
        images={character.images ?? []}
        placeholder="外形会根据参考图写在这里。也可以自己写：高马尾、圆脸、黑眼。不要写这集会换的衣服。"
        onLook={(look, image) => onChange({ ...character, look, ...(image ? { images: [image] } : {}) })}
      />
    </Flex>
  )
}

function OutfitRow({
  outfit,
  characters,
  onChange,
  onRemove,
}: {
  outfit: BibleOutfit
  characters: BibleCharacter[]
  onChange: (next: BibleOutfit) => void
  onRemove: () => void
}) {
  return (
    <Flex vertical gap={6}>
      <Space wrap>
        <Select
          value={outfit.characterId}
          style={{ minWidth: 120 }}
          options={characters.map((item) => ({ value: item.id, label: item.name || '未命名' }))}
          onChange={(characterId) => onChange({ ...outfit, characterId })}
        />
        <Input placeholder="衣服名，如白衬衫" value={outfit.name} onChange={(e) => onChange({ ...outfit, name: e.target.value })} />
        <Button danger onClick={onRemove}>
          删除
        </Button>
      </Space>
      <RefImage
        images={outfit.images ?? []}
        prompt={`单件服装平铺，纯色浅灰背景，不要人物。${outfit.name}。${outfit.look}`}
        ready={Boolean(outfit.name.trim() || outfit.look.trim())}
        onChange={(images) => onChange({ ...outfit, images })}
      />
      <LookTalk
        kind="outfit"
        name={outfit.name}
        look={outfit.look}
        images={outfit.images ?? []}
        placeholder="衣服描述会根据参考图写在这里。以后每镜都按这句画。"
        onLook={(look, image) => onChange({ ...outfit, look, ...(image ? { images: [image] } : {}) })}
      />
    </Flex>
  )
}

function PlaceRow({ place, onChange, onRemove }: { place: BiblePlace; onChange: (next: BiblePlace) => void; onRemove: () => void }) {
  return (
    <Flex vertical gap={6}>
      <Space>
        <Input placeholder="场景名，如卧室" value={place.name} onChange={(e) => onChange({ ...place, name: e.target.value })} />
        <Button danger onClick={onRemove}>
          删除
        </Button>
      </Space>
      <RefImage
        images={place.images ?? []}
        wide
        prompt={`空镜场景，不要人物。${place.name}。${place.look}`}
        ready={Boolean(place.name.trim() || place.look.trim())}
        onChange={(images) => onChange({ ...place, images })}
      />
      <LookTalk
        kind="place"
        name={place.name}
        look={place.look}
        images={place.images ?? []}
        placeholder="场景陈设会根据参考图写在这里：床靠窗、暖色台灯、木地板。"
        onLook={(look, image) => onChange({ ...place, look, ...(image ? { images: [image] } : {}) })}
      />
      <PlaceProps title="默认物件" props={place.props} onChange={(props) => onChange({ ...place, props })} />
    </Flex>
  )
}

function LookTalk({
  kind,
  name,
  look,
  images,
  placeholder,
  onLook,
}: {
  kind: 'character' | 'outfit' | 'place'
  name: string
  look: string
  images: string[]
  placeholder: string
  onLook: (look: string, image?: string) => void
}) {
  const [ask, setAsk] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  async function run(message?: string) {
    setBusy(message ? 'talk' : 'img')
    setError('')
    try {
      const next = await reviseBibleLook({ kind, name, look, images, message })
      if (!message) {
        onLook(next)
        return
      }
      const image = await drawBibleImage({ kind, name, look: next, message, base: images[0] ?? '', images })
      onLook(next, image)
    } catch (err) {
      setError(err instanceof Error ? err.message : '描述没写成')
    } finally {
      setBusy('')
    }
  }

  return (
    <Flex vertical gap={6}>
      <Tooltip title={look.trim() || undefined} styles={{ container: { maxWidth: 420, whiteSpace: 'pre-wrap' } }}>
        <Input.TextArea
          placeholder={placeholder}
          value={look}
          autoSize={{ minRows: 2, maxRows: 4 }}
          onChange={(e) => onLook(e.target.value)}
        />
      </Tooltip>
      <Button disabled={images.length === 0 || busy !== ''} loading={busy === 'img'} onClick={() => void run()}>
        根据图写描述
      </Button>
      <Space.Compact>
        <Input
          placeholder="跟 AI 改这句，比如：头发改成短发"
          value={ask}
          disabled={busy !== '' || (!look.trim() && images.length === 0)}
          onChange={(e) => setAsk(e.target.value)}
          onPressEnter={() => {
            const message = ask.trim()
            if (!message || busy) return
            setAsk('')
            void run(message)
          }}
        />
        <Button
          disabled={busy !== '' || !ask.trim()}
          loading={busy === 'talk'}
          onClick={() => {
            const message = ask.trim()
            if (!message) return
            setAsk('')
            void run(message)
          }}
        >
          改
        </Button>
      </Space.Compact>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
    </Flex>
  )
}

const REF_CAP = 8

function addRefs(current: string[], next: string[]): string[] {
  return [...new Set([...current, ...next])].slice(0, REF_CAP)
}

function RefImage({
  images,
  prompt,
  ready,
  wide,
  onChange,
}: {
  images: string[]
  prompt: string
  ready: boolean
  wide?: boolean
  onChange: (images: string[]) => void
}) {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [held, setHeld] = useState<Array<{ key: string; image: string }>>([])
  const [dropped, setDropped] = useState<string[]>([])
  const [stills, setStills] = useState<Array<{ key: string; image: string; title: string; src: string }>>([])

  function toggle(key: string) {
    if (held.some((item) => item.key === key)) {
      setDropped((cur) => (cur.includes(key) ? cur.filter((item) => item !== key) : [...cur, key]))
      return
    }
    setPicked((cur) => {
      if (cur.includes(key)) return cur.filter((item) => item !== key)
      const room = REF_CAP - images.length + dropped.length - cur.length
      if (room <= 0) return cur
      return [...cur, key]
    })
  }

  async function onGenerate() {
    if (images.length >= REF_CAP) return
    setBusy('gen')
    setError('')
    try {
      const extra = note.trim()
      onChange(addRefs(images, [await generateBibleImage(extra ? `${prompt}。这次再补充：${extra}` : prompt, Boolean(wide))]))
    } catch (err) {
      setError(err instanceof Error ? err.message : '参考图没生成')
    } finally {
      setBusy('')
    }
  }

  async function openPick() {
    setOpen(true)
    setPicked([])
    setDropped([])
    setError('')
    const saved: Array<{ key: string; image: string; title: string; src: string }> = []
    const seen = new Set<string>()
    function push(image: string, title: string) {
      if (!image || seen.has(image)) return
      seen.add(image)
      saved.push({ key: image, image, title, src: bibleImageSrc(image) })
    }
    try {
      const bible = await fetchBible()
      for (const character of bible.characters) {
        for (const image of character.images ?? []) push(image, character.name || '角色')
      }
      for (const outfit of bible.outfits) {
        for (const image of outfit.images ?? []) push(image, outfit.name || '衣服')
      }
      for (const place of bible.places) {
        for (const image of place.images ?? []) push(image, place.name || '场景')
      }
    } catch {
      /* 设定没读出来就只看图库 */
    }
    try {
      for (const image of await fetchBibleLibrary()) push(image, '保存的画面')
    } catch {
      /* 图库没有就空着 */
    }
    setStills(saved)
    setHeld(saved.filter((item) => images.includes(item.image)).map((item) => ({ key: item.key, image: item.image })))
  }

  async function takePicked() {
    const dropNames = new Set(held.filter((item) => dropped.includes(item.key)).map((item) => item.image))
    const kept = images.filter((name) => !dropNames.has(name))
    const chosen = stills.filter((shot) => picked.includes(shot.key))
    if (!dropNames.size && !chosen.length) return
    setBusy('pick')
    setError('')
    try {
      onChange(addRefs(kept, chosen.map((shot) => shot.image)))
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '没放进参考图')
    } finally {
      setBusy('')
    }
  }

  return (
    <Flex vertical gap={6}>
      <Image.PreviewGroup>
        <Flex wrap gap={8}>
          {images.map((name) => (
            <div key={name} className="reel__refwrap">
              <Image className="reel__ref" src={bibleImageSrc(name)} alt="" />
              <button type="button" className="reel__refx" aria-label="去掉这张" onClick={() => onChange(images.filter((item) => item !== name))}>
                ×
              </button>
            </div>
          ))}
        </Flex>
      </Image.PreviewGroup>
      <Input
        placeholder="生成时要补充的，比如：正面、不要配饰。不填就按上面的描述出"
        value={note}
        disabled={busy === 'gen'}
        onChange={(e) => setNote(e.target.value)}
        onPressEnter={() => {
          if (!ready || busy !== '' || images.length >= REF_CAP) return
          void onGenerate()
        }}
      />
      <Space wrap>
        <Button disabled={!ready || busy !== '' || images.length >= REF_CAP} loading={busy === 'gen'} onClick={() => void onGenerate()}>
          生成参考图
        </Button>
        <Button disabled={busy !== ''} onClick={() => void openPick()}>
          用已保存的图
        </Button>
        <Upload
          accept="image/png,image/jpeg,image/webp"
          showUploadList={false}
          customRequest={(options) => {
            void uploadBibleImage(options.file as File)
              .then((name) => {
                onChange(addRefs(images, [name]))
                options.onSuccess?.({})
              })
              .catch((err: Error) => options.onError?.(err))
          }}
        >
          <Button disabled={images.length >= REF_CAP}>上传</Button>
        </Upload>
      </Space>
      {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
      <Modal
        title="选已保存的参考图，可多选"
        open={open}
        okText={picked.length && dropped.length ? '更新' : picked.length ? `放入 ${picked.length} 张` : dropped.length ? `去掉 ${dropped.length} 张` : '放入'}
        okButtonProps={{ disabled: !picked.length && !dropped.length, loading: busy === 'pick' }}
        onOk={() => void takePicked()}
        onCancel={() => setOpen(false)}
      >
        {stills.length === 0 ? (
          <Typography.Text type="secondary">还没有保存过参考图。生成或上传之后，先点右上角保存。</Typography.Text>
        ) : (
          <Image.PreviewGroup>
            <Flex wrap gap={8}>
              {stills.map((shot) => {
                const already = held.some((item) => item.key === shot.key)
                const off = dropped.includes(shot.key)
                const on = (already && !off) || picked.includes(shot.key)
                return (
                  <div key={shot.key} className={on ? 'reel__pick is-on' : 'reel__pick'}>
                    <Image src={shot.src} alt="" />
                    <label>
                      <input type="checkbox" checked={on} onChange={() => toggle(shot.key)} />
                      <Tooltip title={shot.title} styles={{ container: { maxWidth: 360, whiteSpace: 'pre-wrap' } }}>
                        <span>{shot.title}</span>
                      </Tooltip>
                    </label>
                  </div>
                )
              })}
            </Flex>
          </Image.PreviewGroup>
        )}
      </Modal>
    </Flex>
  )
}

function PlaceProps({ title, props, onChange }: { title: string; props: PropSpot[]; onChange: (next: PropSpot[]) => void }) {
  return (
    <Flex vertical gap={6}>
      <Typography.Text>{title}</Typography.Text>
      {props.map((spot, index) => (
        <Space key={`${spot.name}-${index}`}>
          <Input
            placeholder="物件，如玩偶"
            value={spot.name}
            onChange={(e) => onChange(props.map((item, i) => (i === index ? { ...item, name: e.target.value } : item)))}
          />
          <Input
            placeholder="位置，如床头"
            value={spot.where}
            onChange={(e) => onChange(props.map((item, i) => (i === index ? { ...item, where: e.target.value } : item)))}
          />
          <Button onClick={() => onChange(props.filter((_, i) => i !== index))}>去掉</Button>
        </Space>
      ))}
      <Button onClick={() => onChange([...props, { name: '', where: '' }])}>加一件物件</Button>
    </Flex>
  )
}
